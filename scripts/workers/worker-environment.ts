import dotenv from 'dotenv';

// Production process managers inject the environment directly. Local CLI
// execution mirrors the Web launcher and gives .env.local precedence.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });
