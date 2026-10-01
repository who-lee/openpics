import type { OpenPicsBridge } from '@shared/bridge'

/** Throws loudly if the preload bridge is missing, rather than failing silently later. */
export const bridge: OpenPicsBridge = window.opencpics