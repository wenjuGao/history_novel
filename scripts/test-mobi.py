import importlib.util, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('converter',Path(__file__).with_name('convert-mobi.py'))
converter=importlib.util.module_from_spec(spec);spec.loader.exec_module(converter)
class MobiTests(unittest.TestCase):
    def test_invalid_header(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'bad.mobi';p.write_bytes(b'not a mobi')
            with self.assertRaisesRegex(ValueError,'有效'): converter.convert(p,Path(d)/'out')
    def test_encrypted_rejected_before_unpack(self):
        import struct
        raw=bytearray(110);raw[60:68]=b'BOOKMOBI';struct.pack_into('>H',raw,76,1);struct.pack_into('>I',raw,78,86);struct.pack_into('>H',raw,98,2);raw[102:106]=b'MOBI'
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'locked.mobi';p.write_bytes(raw)
            with self.assertRaisesRegex(ValueError,'加密'): converter.convert(p,Path(d)/'out')
    def test_real_conversion_manifest(self):
        import json,hashlib
        reports=list(Path('data/local/converted').glob('*/manifest.json'))
        chinese=[json.loads(p.read_text()) for p in reports if json.loads(p.read_text())['sourceName'].startswith('冰与火之歌')]
        self.assertEqual(len(chinese),5)
        for r in chinese:
            text=Path(r['textPath']).read_bytes()
            self.assertEqual(hashlib.sha256(text).hexdigest(),r['textSha256'])
            self.assertGreater(r['characters'],500000)
            self.assertEqual(r['replacementCharacters'],0)
            self.assertTrue(r['tableOfContents'])
            self.assertTrue(all(t['resolved'] for t in r['tableOfContents']))
            self.assertEqual(hashlib.sha256(Path(r['originalPath']).read_bytes()).hexdigest(),r['sourceSha256'])
if __name__=='__main__':unittest.main()
