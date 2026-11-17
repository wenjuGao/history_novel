"""Convert unencrypted MOBI to local text + provenance; never fetch external assets."""
import argparse, contextlib, hashlib, io, json, os, shutil, struct, tempfile, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from bs4 import BeautifulSoup
from mobi.kindleunpack import unpackBook

MAX_BYTES = 32 * 1024 * 1024
MAX_TEXT = 32 * 1024 * 1024

def convert(source, output):
    source = Path(source).resolve()
    if source.stat().st_size > MAX_BYTES:
        raise ValueError('MOBI 文件超过 32 MB。')
    raw = source.read_bytes()
    if len(raw) < 86 or raw[60:68] != b'BOOKMOBI':
        raise ValueError('不是有效的 MOBI 文件。')
    count = struct.unpack_from('>H', raw, 76)[0]
    if not count or len(raw) < 78 + count * 8:
        raise ValueError('MOBI 记录表损坏。')
    offsets = [struct.unpack_from('>I',raw,78+i*8)[0] for i in range(count)]
    if offsets != sorted(offsets) or offsets[0] < 78+count*8 or offsets[-1] >= len(raw):
        raise ValueError('MOBI 记录偏移无效。')
    off = offsets[0]
    if off+20 > len(raw) or raw[off+16:off+20] != b'MOBI':
        raise ValueError('缺少 MOBI 头。')
    if struct.unpack_from('>H',raw,off+12)[0] != 0:
        raise ValueError('文件已加密，不支持转换。')
    blocks, headings, toc = [], [], []
    def consume(html, origin):
        soup = BeautifulSoup(html, 'html.parser')
        for node in soup(['script','style','nav']): node.decompose()
        # Keep all text, including front matter and notes, in document order.
        for heading in soup.select('h1,h2,h3,h4,h5,h6,p[align="center"]'):
            label = heading.get_text(' ',strip=True)
            if label: headings.append({'title':label,'origin':origin})
        for link in soup.select('a[href^="#"]'):
            title = link.get_text(' ',strip=True)
            target = link.get('href')[1:]
            if title: toc.append({'title':title,'target':target,'resolved':soup.find(id=target) is not None,'origin':origin})
        text = soup.get_text('\n',strip=True)
        if text.strip(): blocks.append(text)
    with tempfile.TemporaryDirectory(prefix='history-mobi-') as temp:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            unpackBook(str(source),temp,epubver='A')
        epubs = list(Path(temp).glob('mobi8/*.epub'))
        html = Path(temp)/'mobi7/book.html'
        if epubs:
            with zipfile.ZipFile(epubs[0]) as z:
                if sum(i.file_size for i in z.infolist()) > 128*1024*1024:
                    raise ValueError('解包内容过大。')
                container=ET.fromstring(z.read('META-INF/container.xml'))
                package=next(e.attrib['full-path'] for e in container.iter() if e.tag.endswith('rootfile'))
                root=ET.fromstring(z.read(package)); ns={'o':'http://www.idpf.org/2007/opf'}
                manifest={e.attrib['id']:e.attrib['href'] for e in root.findall('o:manifest/o:item',ns)}
                from urllib.parse import unquote
                import posixpath
                for item in root.findall('o:spine/o:itemref',ns):
                    href=posixpath.normpath(posixpath.join(posixpath.dirname(package),unquote(manifest[item.attrib['idref']]).split('#')[0]))
                    consume(z.read(href),href)
        elif html.exists(): consume(html.read_bytes(),'mobi7/book.html')
        else: raise ValueError('文件没有可提取的 HTML/EPUB 正文。')
    text='\n\n'.join(blocks)+'\n'
    if not text.strip() or len(text.encode('utf8'))>MAX_TEXT or '\x00' in text:
        raise ValueError('正文为空、过大或包含无效字符。')
    replacements=text.count('\ufffd')
    if replacements>max(5,len(text)//10000): raise ValueError('正文编码异常，请检查原文件。')
    digest=hashlib.sha256(raw).hexdigest()
    dest=Path(output).resolve()/digest
    dest.mkdir(parents=True,exist_ok=True,mode=0o700)
    # A content-addressed directory preserves the original and makes repeat conversion idempotent.
    shutil.copyfile(source,dest/'original.mobi')
    (dest/'text.txt').write_text(text,encoding='utf8')
    info={'schemaVersion':1,'sourceName':source.name,'sourceSha256':digest,'sourceBytes':len(raw),'textSha256':hashlib.sha256(text.encode()).hexdigest(),'characters':len(text),'replacementCharacters':replacements,'headings':headings,'tableOfContents':toc,'paragraphs':len(text.splitlines()),'converter':'mobi 0.4.1 / BeautifulSoup 4.15.0','coverage':'all extracted text in reading order; file extraction is not edition completeness verification','textPath':str(dest/'text.txt'),'originalPath':str(dest/'original.mobi')}
    (dest/'manifest.json').write_text(json.dumps(info,ensure_ascii=False,indent=2),encoding='utf8')
    return info

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('source');parser.add_argument('--output',default='data/local/converted');args=parser.parse_args()
    try: print(json.dumps(convert(args.source,args.output),ensure_ascii=False))
    except Exception as error:
        # Avoid dumping book content or library internals into server logs.
        print(json.dumps({'error':str(error) if isinstance(error,ValueError) else 'MOBI 转换失败，请检查文件或依赖。'},ensure_ascii=False));raise SystemExit(1)
