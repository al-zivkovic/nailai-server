import loadEnv from './utils/env.js';
import app from './app.js';

loadEnv();

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${port}`);
});
