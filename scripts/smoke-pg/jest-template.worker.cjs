const { cloneWorkerDatabase } = require("@cedarjs/pg/jest/template");

beforeAll(() => cloneWorkerDatabase());
