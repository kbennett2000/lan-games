/**
 * helpers/socket.js
 *
 * Lightweight wrappers around socket.io-client for integration tests.
 * All helpers time out after TIMEOUT_MS to prevent a hung test from
 * blocking the whole suite.
 */

'use strict';

const { io: ioClient } = require('socket.io-client');

const TIMEOUT_MS = 8_000;

/**
 * Open a socket.io connection and wait until it is fully connected.
 *
 * @param {string} url    Base server URL, e.g. "http://127.0.0.1:54321"
 * @param {string} token  JWT returned by register/login
 * @returns {Promise<import('socket.io-client').Socket>}
 */
function connectSocket(url, token) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Socket connect timeout')),
      TIMEOUT_MS,
    );

    const socket = ioClient(url, {
      auth:         { token },
      transports:   ['websocket'], // skip HTTP polling upgrade
      reconnection: false,         // tests manage reconnection explicitly
    });

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Disconnect a socket and wait until it is fully closed.
 *
 * @param {import('socket.io-client').Socket} socket
 */
function disconnectSocket(socket) {
  return new Promise(resolve => {
    if (!socket.connected) { resolve(); return; }
    socket.once('disconnect', resolve);
    socket.disconnect();
  });
}

/**
 * Wait for a single occurrence of an event, then resolve with the payload.
 * Rejects after TIMEOUT_MS.
 *
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event
 * @param {number} [timeoutMs]
 */
function waitFor(socket, event, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for socket event '${event}'`)),
      timeoutMs,
    );
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Emit a socket event that uses an acknowledgement callback and resolve with
 * the ack payload.  Rejects if the ack contains an { error } field.
 *
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event
 * @param {...*} args  Arguments before the ack callback
 */
function emitAck(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ack on '${event}'`)),
      TIMEOUT_MS,
    );
    socket.emit(event, ...args, (ack) => {
      clearTimeout(timer);
      if (ack?.error) reject(new Error(`Socket ack error on '${event}': ${ack.error}`));
      else            resolve(ack);
    });
  });
}

module.exports = { connectSocket, disconnectSocket, waitFor, emitAck };
