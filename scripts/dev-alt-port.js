// Dev helper: run the app on an alternate port (avoids clashing with another dev server on 3000)
process.env.PORT = process.env.PORT || '3100';
require('../server.js');
