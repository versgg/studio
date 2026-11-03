// The Text tab's preset styles, as in CapCut: "Aa" in each style (the first takes the style
// off), then your own presets, and "Save as preset" for the look the text has now. A preset
// style changes only colour, outline, shadow and box; one of yours brings its whole look.

import { DIcon } from './design-icons'
import { Buttons } from './InspectorBlocks'
import { deleteMyPreset, myPresetLook, saveMyPreset, useMyPresets } from './myPresets'
import { STYLE_PRESETS, presetLook, presetOf, specCss } from './textPresets'
import type { TextLook } from './textRender'
import { getState, toast } from './store'

const SWATCH: TextLook = { content: 'Aa', font: 'Metropolis', size: 100, weight: 800, color: '#FFFFFF', align: 'center', lineHeight: 1, letterSpacing: 0, case: 'none', stroke: null, shadow: null, background: null }

// A swatch's box is drawn at 40 % of its real size, so it fits the tile round its "Aa".
export function PresetStyles({ look, onPick }: { look: TextLook; onPick: (patch: Partial<TextLook>) => void }) {
  const mine = useMyPresets()
  const current = presetOf(look)
  const width = getState().snap?.project.width ?? 1080
  const save = async () => {
    const name = await saveMyPreset(look, width)
    toast(`Saved as “${name}”. It’s under Your presets in every project.`)
  }
  return (
    <>
      <div className="preset-styles" role="group" aria-label="Preset styles">
        {STYLE_PRESETS.map(({ name, style }) => (
          <button key={name} type="button" title={name} aria-label={`${name} style`} aria-pressed={name === current} className={name === current ? 'on' : ''} onClick={() => onPick(presetLook(style, look.size))}>
            {name === 'None' ? <DIcon d="M3.5 12.5l9-9 M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z" size={18} stroke="#8a8a93" /> : <span style={specCss({ ...SWATCH, ...presetLook(style, 100), background: presetLook(style, 40).background }, 0.2)}>Aa</span>}
          </button>
        ))}
      </div>
      {mine.length > 0 && (
        <>
          <p className="preset-mine-title">Your presets</p>
          <div className="preset-styles" role="group" aria-label="Your presets">
            {mine.map((p) => (
              <span key={p.name} className="preset-mine">
                <button type="button" title={`${p.name} · ${p.look.font === 'Metropolis' ? 'System' : p.look.font}`} aria-label={`${p.name} preset`} onClick={() => onPick(myPresetLook(p, width))}>
                  <span style={specCss({ ...p.look, content: 'Aa', size: 100, align: 'center', lineHeight: 1 }, 0.2)}>Aa</span>
                </button>
                <button type="button" className="preset-remove" title={`Remove ${p.name}`} aria-label={`Remove ${p.name}`} onClick={() => deleteMyPreset(p.name)}>
                  <DIcon d="M4.5 4.5l7 7 M11.5 4.5l-7 7" size={8} width={2} />
                </button>
              </span>
            ))}
          </div>
        </>
      )}
      <Buttons items={[{ label: 'Save as preset', onClick: save, title: 'Keeps this font, size, colours, outline, shadow and box, for any text in any project' }]} />
    </>
  )
}
