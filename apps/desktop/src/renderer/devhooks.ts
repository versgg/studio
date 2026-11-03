// For tests only (STUDIO_SILENT=1): the library and Inspector actions on `window.__studioDev`,
// so an off-screen test can call them directly (and check what they draw and send) without
// clicking through every panel. Nothing is exposed in normal use.

import * as act from './libraryActions'
import * as audioSamples from './audioSamples'
import * as captions from './captions'
import * as looks from './looks'
import * as masks from './masks'
import * as sounds from './soundLibrary'
import * as stickers from './stickers'
import * as presets from './textPresets'
import * as textRender from './textRender'
import * as textExport from './textExport'
import { getState, setState } from './store'
import * as vision from './vision'

if (window.studio?.silent) (window as unknown as { __studioDev: object }).__studioDev = { act, audioSamples, captions, looks, masks, presets, sounds, stickers, textRender, vision, textExport, store: { getState, setState } }
