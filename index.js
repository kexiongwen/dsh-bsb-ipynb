// dsh-bsb-ipynb host entry.
//
// Registers the /ipynb HTTP API with better-sidebar's web server and owns the
// per-notebook Python kernel processes. The browser half is declared in
// package.json (dsh.client) and served from client.js.

import { fileURLToPath } from 'node:url'
import { KernelManager } from './lib/kernel.js'
import { registerIpynbRoutes } from './lib/routes.js'

export const inject = ['webServer', 'sessions', 'connection']

export function apply(ctx) {
  const bridgePath = fileURLToPath(new URL('./python/bridge.py', import.meta.url))
  const kernels = new KernelManager(ctx, bridgePath)
  ctx.effect(() => registerIpynbRoutes(ctx, kernels))
  ctx.effect(() => () => {
    void kernels.disposeAll()
  })
}
