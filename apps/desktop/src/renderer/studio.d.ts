import type { StudioApi } from '../shared/api'

declare global {
  interface Window {
    studio: StudioApi
  }
}
