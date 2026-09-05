const path = require('path');
const dotenv = require('dotenv');

/** Match Next.js precedence: process environment > .env.local > .env. */
function loadProjectEnvironment({
  rootDir = path.join(__dirname, '..', '..'),
  target = process.env,
} = {}) {
  dotenv.config({
    path: [path.join(rootDir, '.env.local'), path.join(rootDir, '.env')],
    processEnv: target,
    override: false,
    quiet: true,
  });
  return target;
}

module.exports = { loadProjectEnvironment };
