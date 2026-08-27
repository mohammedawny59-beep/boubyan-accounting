// P0.1 — MongoDB-mode tenant-scoping checks, using mocked Mongoose models.
//
// WHY MOCKED: this sandbox has no live MongoDB reachable, and the safety
// rules for this milestone forbid touching any real/production database.
// The behavior these tests verify (hydrateFromMongo()/ensureAdminUser()
// building tenant-scoped queries; tenantMiddleware failing closed against a
// suspended/nonexistent tenant) only runs when MongoDB is connected — it is
// unreachable from the file-mode HTTP integration suite
// (tests/tenant-isolation-http.test.js), which forces DB_FILE_ONLY=true.
//
// These tests assert the EXACT query filters lib/database.js and
// lib/tenantMiddleware.js send to Mongoose, using jest.mock — no network, no
// real database, fully deterministic. See Milestone P0.1 report §9 for why
// this substitutes for an end-to-end MongoDB run.

jest.mock('mongoose', () => ({
  connect: jest.fn().mockResolvedValue(undefined),
  connection: {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    readyState: 1, // pretend "connected" for every test in this file
  },
}));

jest.mock('../models/User', () => ({
  find: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([]) })),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(1),
  deleteMany: jest.fn().mockResolvedValue({}),
  bulkWrite: jest.fn().mockResolvedValue({}),
}));

jest.mock('../models/EntityChunk', () => ({
  find: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([]) })),
  countDocuments: jest.fn().mockResolvedValue(1),
  updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../models/AppConfig', () => ({
  findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })),
  updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../models/LegacyKV', () => ({
  findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../models/Tenant', () => ({
  findOne: jest.fn(),
}));

// lib/tenantMiddleware.js requires Subscription at module load time even
// though tenantMiddleware() itself doesn't call it — mock it so the real
// models/Subscription.js (which needs a real mongoose.Schema) never loads.
jest.mock('../models/Subscription', () => ({}));

// P0.12 — lib/database.js now requires IdempotencyRecord at module load
// time too (same reason as Subscription above): the real models/
// IdempotencyRecord.js needs a real mongoose.Schema to define its schema,
// which the minimal mongoose mock above does not provide. Not exercised by
// this file's own tests (tenant-scoping query construction only) — mocked
// as a stub so requiring it never touches the real Schema. initDB() awaits
// IdempotencyRecord.init() right after mongoose.connect() (ensures the
// unique index is ready before serving requests), so the stub must provide
// a resolving init() too — otherwise that call throws and initDB() silently
// falls back to file mode, which is exactly the failure this stub must NOT
// cause (it would make every "Mongo mode" test in this file exercise file
// mode instead, without any test-visible error).
jest.mock('../models/IdempotencyRecord', () => ({
  init: jest.fn().mockResolvedValue(undefined),
}));

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'p0-1-mongo-mode-test-secret';

const User = require('../models/User');
const EntityChunk = require('../models/EntityChunk');
const Tenant = require('../models/Tenant');

describe('P0.1 — hydrateFromMongo()/ensureAdminUser() build tenant-scoped queries (Mongo mode)', () => {
  test('initDB() (Mongo branch) scopes every boot-time User/EntityChunk query to the default tenant, with a legacy-doc fallback', async () => {
    const { initDB } = require('../lib/database');

    await initDB({
      mongoUri: 'mongodb://mocked/unused',
      dataFile: null,
      configFile: null,
      defaultConfig: {},
      buildInitialDB: () => ({ roles: { admin: {} } }),
      migrateDB: () => false,
    });

    // hydrateFromMongo() must never call User.find()/EntityChunk.find() with
    // no filter at all (that was the P0.1 root-cause bug — it would pull
    // every tenant's data into the shared default cache).
    expect(User.find).toHaveBeenCalled();
    for (const call of User.find.mock.calls) {
      const filter = call[0];
      expect(filter).toBeDefined();
      expect(filter.$or).toEqual(
        expect.arrayContaining([
          { tenantId: 'default' },
          { tenantId: { $exists: false } },
          { tenantId: null },
        ]),
      );
    }

    expect(EntityChunk.find).toHaveBeenCalled();
    const chunkCall = EntityChunk.find.mock.calls.find(c => c[0] && c[0].key);
    expect(chunkCall).toBeDefined();
    expect(chunkCall[0].$or).toEqual(
      expect.arrayContaining([
        { tenantId: 'default' },
        { tenantId: { $exists: false } },
        { tenantId: null },
      ]),
    );

    // ensureAdminUser() must scope its admin lookup the same way, and must
    // never search/reset an admin account belonging to another real tenant.
    expect(User.findOne).toHaveBeenCalled();
    for (const call of User.findOne.mock.calls) {
      const filter = call[0];
      expect(filter.$or).toEqual(
        expect.arrayContaining([
          { tenantId: 'default' },
          { tenantId: { $exists: false } },
          { tenantId: null },
        ]),
      );
    }

    // The seeded admin user (findOne mocks both resolve null → User.create runs)
    // must be explicitly tagged tenantId:'default', never left ambiguous.
    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'default' }),
    );
  });
});

describe('P0.1 — tenantMiddleware fails closed against a suspended/nonexistent tenant (Mongo mode)', () => {
  const { tenantMiddleware } = require('../lib/tenantMiddleware');

  function mockRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  }

  // P0.4 — Step 4 added a live-user check to tenantMiddleware itself: every
  // request must resolve to a real, active user record in the CURRENT
  // tenant context, not just a syntactically-valid JWT. These tests all use
  // req.user.id='x', so seed a matching live user (re-running initDB() so
  // the default-tenant cache — populated once by the earlier describe
  // block's own initDB() call — is refreshed with it; non-default tenants
  // hydrate lazily per-test via the same User.find mock).
  beforeAll(async () => {
    User.find.mockImplementation(() => ({
      lean: () => Promise.resolve([{ id: 'x', tenantId: 'default', username: 'x', role: 'admin', active: true }]),
    }));
    const { initDB } = require('../lib/database');
    await initDB({
      mongoUri: 'mongodb://mocked/unused2',
      dataFile: null,
      configFile: null,
      defaultConfig: {},
      buildInitialDB: () => ({ roles: { admin: {} } }),
      migrateDB: () => false,
    });
  });

  beforeEach(() => {
    Tenant.findOne.mockReset();
  });

  test('rejects (403) a JWT tenantId that matches no Tenant document at all', async () => {
    Tenant.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    const req = { user: { id: 'x', tenantId: 'ghost-tenant' } };
    const res = mockRes();
    const next = jest.fn();

    await tenantMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('rejects (403) a JWT tenantId belonging to a suspended tenant — never falls back to default data', async () => {
    Tenant.findOne.mockReturnValue({ lean: () => Promise.resolve({ tenantId: 'tenant-x', status: 'suspended' }) });
    const req = { user: { id: 'x', tenantId: 'tenant-x' } };
    const res = mockRes();
    const next = jest.fn();

    await tenantMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('allows through (calls next) a JWT tenantId belonging to a real, active tenant', async () => {
    Tenant.findOne.mockReturnValue({ lean: () => Promise.resolve({ tenantId: 'tenant-ok', status: 'active' }) });
    const req = { user: { id: 'x', tenantId: 'tenant-ok' } };
    const res = mockRes();
    const next = jest.fn();

    await tenantMiddleware(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(req.tenantId).toBe('tenant-ok');
  });

  test('the default tenant is always allowed through without a Tenant lookup', async () => {
    const req = { user: { id: 'x', tenantId: 'default' } };
    const res = mockRes();
    const next = jest.fn();

    await tenantMiddleware(req, res, next);

    expect(Tenant.findOne).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
