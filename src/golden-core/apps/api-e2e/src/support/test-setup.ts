import axios from 'axios';

// Configure axios for tests to use.
const host = process.env.HOST ?? 'localhost';
const port = process.env.PORT ?? '3333';
axios.defaults.baseURL = `http://${host}:${port}`;
