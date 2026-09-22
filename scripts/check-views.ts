// Validates the shipped view templates and prints the Maestro catalog docs size.
// Run: pnpm check:views (add --docs to print what Maestro reads)
import { TEMPLATES } from '../src/shared/views/templates'
import { validateView } from '../src/shared/views/validate'
import { catalogDocs } from '../src/shared/views/catalog-docs'

let bad = 0
for (const t of TEMPLATES) {
  const issues = validateView(t.view)
  if (issues.length) {
    bad++
    console.log(`✗ ${t.id}`)
    for (const i of issues) console.log(`   ${i.path}: ${i.message}`)
  } else console.log(`✓ ${t.id}`)
}
const broken = validateView({ title: 'x', slot: 'home', sources: { a: { source: 'nope' } }, spec: { root: 'r', elements: { r: { type: 'Card', props: { title: 3, bogus: 1 }, children: ['missing'], on: { press: { action: 'rm -rf' } } } } } })
console.log(`negative case: ${broken.length} issues`)
if (broken.length < 4) bad++
if (process.argv.includes('--docs')) console.log(catalogDocs())
else console.log(`catalog docs: ${catalogDocs().length} chars`)
process.exit(bad ? 1 : 0)
