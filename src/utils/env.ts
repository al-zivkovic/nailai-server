import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

export function loadEnv(): void {
  const root = process.cwd();

  const loadIfExists = (p: string, override = false) => {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p, override });
    }
  };

  // Base .env first
  loadIfExists(path.join(root, '.env'));

  // Environment-specific overrides
  const env = process.env.NODE_ENV || 'development';
  const envFiles = [
    `.env.${env}`,
    env === 'development' ? '.env.dev' : '',
    env === 'production' ? '.env.prod' : ''
  ];
  for (const file of envFiles) {
    if (!file) continue;
    loadIfExists(path.join(root, file), true);
  }
}

export default loadEnv;


