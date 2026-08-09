/**
 * Stand-in for the `server-only` import guard under Vitest.
 *
 * `server-only` is not a real dependency here — Next resolves the specifier
 * through its own bundler alias, which is exactly what makes it a guard: the
 * client build resolves it to a module that throws, so a `'use client'` file
 * importing a server module fails at build time instead of shipping the server
 * code to the browser.
 *
 * Vitest has neither that alias nor a client graph to protect, so without this
 * stub any suite importing a guarded module (src/lib/qr.ts, src/lib/dal.ts)
 * dies on an unresolvable specifier. Deliberately empty: the guard is a
 * build-time concern, and a test asserting it would be asserting Next's
 * bundler, not our code.
 */
export {}
