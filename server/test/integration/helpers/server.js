/**
 * helpers/server.js
 *
 * Starts and stops the real Express + Socket.io server on an ephemeral port.
 * Returns the http.Server, the Socket.io instance, the bound URL, and a
 * supertest agent so tests can make authenticated REST calls easily.
 */

'use strict';

const supertest = require('supertest');
const { createServer } = require('../../../src/app');

/**
 * Start the server, bind to a random free port on 127.0.0.1, and return
 * everything tests need.
 *
 * @returns {Promise<{ httpServer, io, url, api }>}
 *   url — base URL (e.g. "http://127.0.0.1:54321")
 *   api — supertest instance bound to the http server
 */
async function startServer() {
  const { app, httpServer, io } = createServer();

  await new Promise((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', (err) => {
      if (err) reject(err);
      else     resolve();
    });
  });

  const { port } = httpServer.address();
  const url      = `http://127.0.0.1:${port}`;
  const api      = supertest(httpServer);

  return { app, httpServer, io, url, api };
}

/**
 * Gracefully close the Socket.io server then the HTTP server.
 *
 * @param {{ httpServer, io }} server — object returned by startServer()
 */
async function stopServer({ httpServer, io }) {
  await new Promise(resolve => io.close(resolve));
  await new Promise(resolve => httpServer.close(resolve));
}

module.exports = { startServer, stopServer };
