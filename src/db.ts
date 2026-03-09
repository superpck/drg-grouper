import knex from 'knex';
import { config } from './config';

export const db = knex({
  client: 'mysql2',
  connection: config.db,
  pool: { min: 0, max: 10 },
});
