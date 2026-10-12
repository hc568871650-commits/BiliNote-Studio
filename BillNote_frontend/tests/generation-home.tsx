import assert from 'node:assert/strict'
import { HomePage } from '../src/pages/HomePage/Home'
import { navigation, viewChanges } from './shims/generation-home'
const tree = HomePage({}) as any
const newNoteForm = tree.props.NoteForm.props.children[0].props.children
newNoteForm.props.onSubmitted()
assert.equal(viewChanges.at(-1), 'notes')
assert.deepEqual(navigation[0], [{ pathname: '/', search: '?view=read&source=video' }, { replace: true }], 'accepted submission consumes stale create intent while preserving other route parameters')
console.log('generation Home: accepted task opens reading route / stale create intent removed passed')
