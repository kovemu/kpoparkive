import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL) {
    const candidate = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
} });
const { matchStoredNamuMedia, buildNamuResolvedAssetMap, findNamuAssetCandidates } = await import('../lib/namuStoredAssets.ts');
const { readNamuImageBytes, MAX_NAMU_IMAGE_BYTES } = await import('../lib/namuImageBytes.ts');

test('downloads reject error pages, empty images, and unbounded streams', async () => {
  await assert.rejects(readNamuImageBytes(new Response('remote',{status:503})), /503/);
  await assert.rejects(readNamuImageBytes(new Response('<html>challenge</html>',{headers:{'content-type':'text/html'}})), /not an image/);
  await assert.rejects(readNamuImageBytes(new Response('',{headers:{'content-type':'image/png'}})), /empty/);
  await assert.rejects(readNamuImageBytes(new Response(new Uint8Array(MAX_NAMU_IMAGE_BYTES+1),{headers:{'content-type':'image/png'}})), /8 MB/);
  const bytes = new Uint8Array([1,2,3]);
  assert.deepEqual(new Uint8Array(await readNamuImageBytes(new Response(bytes,{headers:{'content-type':'image/png'}}))),bytes);
});

const cover = { id:'cover', bucket:'wiki-media', storage_path:'albums/a.webp', role:'album-cover:a', caption:'A: Song', alt_text:'Group album cover', source_url:'https://source.example/a' };
test('album title matching preserves the role and cluster qualifier', () => {
  for (const file of ['A: Song.jpg', 'A: Song(Group).jpg', 'a song digital cover.png']) {
    assert.equal(matchStoredNamuMedia(file, 'Group', [cover])?.id, 'cover');
  }
  for (const file of ['A: Song 로고.svg', 'A: Song member profile.jpg', 'A: Song(Other Group).jpg']) {
    assert.equal(matchStoredNamuMedia(file, 'Group', [cover]), undefined);
  }
  assert.equal(matchStoredNamuMedia('A: Song.jpg', 'Group', [cover, {...cover,id:'duplicate'}]), undefined);
  assert.equal(matchStoredNamuMedia('A: Song.jpg', 'Group', [{...cover,role:'infobox'}]), undefined);
});
test('remote duplicate rows never overwrite stored files', () => {
  const stored = {source_ref:'파일:A.jpg',label:'A.jpg',resolved_url:'https://storage.example/a',storage_path:'a',metadata:{original_url:'https://cdn.example/a'}};
  const pending = {source_ref:'https://cdn.example/a',label:'파일:A.jpg',resolved_url:null,storage_path:null,metadata:null};
  for(const rows of [[stored,pending],[pending,stored]]) {
    const map = buildNamuResolvedAssetMap(rows);
    assert.equal(map['A.jpg'], stored.resolved_url);
    assert.equal(map['https://cdn.example/a'], stored.resolved_url);
  }
});
test('cluster candidates retain alternatives and reject ambiguous fuzzy aliases', () => {
  assert.deepEqual(findNamuAssetCandidates(['File:Logo (Group).svg'], [
    {'Group Logo.svg':'https://a.example/a'}, {'Group Logo.svg':'https://b.example/b'},
  ]), ['https://a.example/a','https://b.example/b']);
  assert.deepEqual(findNamuAssetCandidates(['Logo Group.svg'], [
    {'Group (Logo).svg':'https://a.example/a','Logo-Group.svg':'https://b.example/b'},
  ]), []);
});
