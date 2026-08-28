require('dotenv').config();
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
      database: process.env.DB_NAME || 'metering_billing',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    });

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
