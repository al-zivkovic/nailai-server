import loadEnv from './utils/env.js';
import app from './app.js';

loadEnv();

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://${host}:${port}`);
});
