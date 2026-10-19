"""Render the two review PRDs as self-contained HTML. Standard library only."""
from pathlib import Path
import argparse, hashlib, html, json, re

CSS = """
:root{--ink:#202b3f;--muted:#6d788b;--line:#e4e8ef;--blue:#385dcc;--bg:#f4f6fa}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;color:var(--ink);background:var(--bg);font:15px/1.85 "Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}button{font:inherit;cursor:pointer}.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:10px;background:#fff;padding:8px;z-index:9}
aside{position:fixed;inset:0 auto 0 0;width:270px;padding:28px 22px;background:#fff;border-right:1px solid var(--line);overflow:auto}.brand{font-size:22px;font-weight:750;letter-spacing:2px}.brand small{display:block;color:var(--muted);font-size:10px;letter-spacing:2px}.edition{display:flex;gap:7px;margin:22px 0}.edition a{padding:5px 10px;border-radius:6px;background:#f0f3f9;font-size:12px}.edition .active{background:#e9edff;color:#2e4eb4}
.toc{display:grid;gap:2px}.toc a{font-size:12px;line-height:1.6;padding:6px 8px;border-radius:5px;color:#566078}.toc a:hover{background:#f3f5fb}.toc .h3{font-size:11px;padding-left:18px;color:#778197}.side-note{font-size:11px;color:var(--muted);margin-top:24px;padding-top:16px;border-top:1px solid var(--line)}
main{margin-left:270px;max-width:1400px;padding:0 44px 44px}.toolbar{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:22px 0;color:var(--muted);font-size:12px}.toolbar div{display:flex;gap:10px;flex-wrap:wrap}.toolbar a,.toolbar button{border:1px solid var(--line);background:#fff;color:#4b586e;padding:6px 12px;border-radius:6px;font-size:12px}.hero{background:#182942;color:#fff;border-radius:15px;padding:40px 44px}.eyebrow{font-size:11px;letter-spacing:2px;color:#a2b7e5}.hero h1{font-size:34px;line-height:1.35;margin:14px 0 16px;font-weight:650}.hero p{margin:0;color:#c5d1e5;font-size:14px}.hero .meta{display:flex;gap:26px;flex-wrap:wrap;border-top:1px solid #ffffff25;padding-top:20px;margin-top:26px;font-size:12px}.meta strong{display:block;color:#fff}.note{margin:20px 0;background:#eaf0ff;border-left:3px solid #7994df;padding:13px 18px;font-size:12px;color:#52627f}
article{background:#fff;padding:28px 42px 52px;border:1px solid var(--line);border-radius:12px}article>h1{font-size:24px;line-height:1.5}h2{font-size:23px;line-height:1.5;margin-top:38px;border-top:1px solid var(--line);padding-top:24px}h3{font-size:17px;line-height:1.6;margin-top:28px}p{margin:13px 0}li{margin:5px 0}blockquote{margin:20px 0;padding:12px 20px;background:#f7f9fc;border-left:3px solid #b2c0df;font-size:12px;color:#5f6d84}code{font-family:Consolas,monospace;font-size:.92em;background:#f0f3f8;padding:2px 5px;border-radius:4px}
.table{overflow:auto;border:1px solid var(--line);border-radius:8px;margin:18px 0}table{border-collapse:collapse;width:100%;font-size:13px;min-width:580px}th,td{padding:11px 13px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th{background:#f3f6fb;font-weight:650}tr:last-child td{border-bottom:0}td:first-child{min-width:100px}pre{padding:18px;background:#f4f6fa;border:1px solid var(--line);border-radius:8px;overflow:auto;font:12px/1.7 Consolas,monospace}pre code{padding:0;background:none;font-size:inherit}details{margin:15px 0}summary{cursor:pointer;font-size:12px;color:var(--muted)}figure{margin:24px 0;padding:18px;background:#f6f8fc;border:1px solid var(--line);border-radius:10px}figure svg{width:100%;height:auto;display:block}figcaption{font-size:11px;color:var(--muted);margin-top:10px}footer{margin-top:24px;color:var(--muted);font-size:11px;display:flex;justify-content:space-between;gap:14px}
:focus-visible{outline:3px solid #7d9cf3;outline-offset:3px}
@media(max-width:1000px){aside{width:220px;padding:22px 14px}main{margin-left:220px;padding:0 22px 28px}article{padding:18px 23px}.hero{padding:28px}.hero h1{font-size:28px}}
@media(max-width:700px){aside{position:static;width:auto;border-right:0;border-bottom:1px solid var(--line);padding:16px 20px}.brand{font-size:18px}.brand small,.toc,.side-note{display:none}.edition{margin:12px 0 0}main{margin:0;padding:0 12px 24px}.toolbar{padding:15px 0}.toolbar>span{display:none}.hero{padding:25px}.hero h1{font-size:27px}article{padding:14px 19px 28px}h2{font-size:21px}body{font-size:14px}.table{margin-left:-6px;margin-right:-6px}footer{display:block}}
@media print{@page{size:A4;margin:16mm}body{background:#fff;font-size:10pt}aside,.toolbar,.skip{display:none}main{margin:0;padding:0;max-width:none}.hero{color:#172842;background:#f0f3f9;padding:22px;break-inside:avoid}.hero p,.eyebrow,.hero .meta{color:#52627f}.meta strong{color:#172842}.hero h1{font-size:25pt}article{border:0;padding:0}h2,h3{break-after:avoid}h2{font-size:18pt}h3{font-size:13pt}p,li{orphans:3;widows:3}.table{overflow:visible}table{min-width:0;font-size:8pt}tr{break-inside:avoid}pre{white-space:pre-wrap;font-size:8pt}figure{break-inside:avoid}details pre{display:block}}
"""
def inline(value):
    bt = chr(96)
    pieces = re.split("(" + bt + "[^" + bt + "]+" + bt + ")", value)
    rendered = []
    for piece in pieces:
        if piece.startswith(bt) and piece.endswith(bt):
            rendered.append("<code>" + html.escape(piece[1:-1]) + "</code>"); continue
        text = html.escape(piece)
        text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", lambda m:
            '<a href="' + m[2].replace(".md", ".html") + '">' + m[1] + "</a>", text)
        text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
        rendered.append(text)
    return "".join(rendered)
def overview(advanced, index):
    labels = (["单页群聊", "协作事实", "项目 Owner", "资源调度", "Runner / 人工", "核验回流"] if advanced else
              ["团队群聊", "统一工作事实", "主协调 Agent", "政策与认领", "受控执行", "成果回原群"])
    if index: labels = ["理解目标", "比对已有工作", "批准新工作", "关联并拒绝重复", "停止过时执行", "结果与复核"]
    items = []
    for i,label in enumerate(labels):
        col,row = i%3,i//3
        x,y = 12+col*238,14+row*86
        items.append(f'<rect x="{x}" y="{y}" width="214" height="58" rx="9" fill="white" stroke="#ced8ed"/>')
        items.append(f'<text x="{x+107}" y="{y+35}" text-anchor="middle" font-size="14" fill="#334d84">{html.escape(label)}</text>')
        if col<2: items.append(f'<path d="M{x+217} {y+29}h15m-4-4 4 4-4 4" fill="none" stroke="#98a9c8"/>')
    items.append('<path d="M595 76v10H119v10m-4-4 4 4 4-4" fill="none" stroke="#98a9c8"/>')
    return '<figure><svg viewBox="0 0 724 178" role="img" aria-label="协调流程概览">'+"".join(items)+'</svg><figcaption>职责／流程概览；完整节点、分支和连线以展开的 Mermaid 源码为准。</figcaption></figure>'
def render_markdown(source, advanced):
    lines,result,headings = source.splitlines(),[],[]
    i,figure_index,heading_index = 0,0,0
    while i<len(lines):
        line=lines[i]
        if not line.strip(): i+=1; continue
        fence=re.match(r"^\s*(\x60{3}|~~~)(\w*)",line)
        if fence:
            lang,content=fence[2],[]
            i+=1
            while i<len(lines) and not lines[i].lstrip().startswith(fence[1]):
                content.append(lines[i]); i+=1
            code="<pre><code>"+html.escape("\n".join(content))+"</code></pre>"
            if lang=="mermaid":
                result.append(overview(advanced,figure_index))
                result.append("<details><summary>展开 Mermaid 源码（完整设计）</summary>"+code+"</details>")
                figure_index+=1
            else: result.append(code)
            i+=1; continue
        heading=re.match(r"^(#{1,4})\s+(.+)",line)
        if heading:
            level,title=len(heading[1]),heading[2]
            heading_index+=1; anchor="section-"+str(heading_index)
            headings.append((level,title,anchor))
            result.append(f'<h{level} id="{anchor}">{inline(title)}</h{level}>')
            i+=1; continue
        if line.startswith(">"):
            quote=[]
            while i<len(lines) and lines[i].startswith(">"):
                quote.append(inline(lines[i].lstrip(">").strip())); i+=1
            result.append("<blockquote>"+"<br>".join(quote)+"</blockquote>"); continue
        if line.startswith("|") and i+1<len(lines) and re.match(r"^\|\s*:?-",lines[i+1]):
            def cells(text): return [inline(x.strip()) for x in text.strip().strip("|").split("|")]
            rows=["<thead><tr>"+"".join("<th>"+x+"</th>" for x in cells(line))+"</tr></thead><tbody>"]
            i+=2
            while i<len(lines) and lines[i].startswith("|"):
                rows.append("<tr>"+"".join("<td>"+x+"</td>" for x in cells(lines[i]))+"</tr>"); i+=1
            result.append('<div class="table"><table>'+"".join(rows)+"</tbody></table></div>"); continue
        bullet=re.match(r"^([-*]|\d+\.)\s+(.+)",line)
        if bullet:
            ordered=bullet[1][0].isdigit(); tag="ol" if ordered else "ul"; items=[]
            while i<len(lines):
                m=re.match(r"^([-*]|\d+\.)\s+(.+)",lines[i])
                if not m or m[1][0].isdigit()!=ordered: break
                items.append("<li>"+inline(m[2])+"</li>"); i+=1
            result.append("<"+tag+">"+"".join(items)+"</"+tag+">"); continue
        paragraph=[line]; i+=1
        while i<len(lines) and lines[i].strip() and not re.match(r"^(#|>|[-*]\s|\d+\.\s|\||~~~|\x60{3})",lines[i]):
            paragraph.append(lines[i]); i+=1
        result.append("<p>"+inline(" ".join(paragraph))+"</p>")
    return "\n".join(result),headings
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--root",type=Path,default=Path(__file__).resolve().parents[3])
    root=parser.parse_args().root.resolve()
    for name,advanced in [("01_MVP需求文档",False),("02_进阶版需求文档",True)]:
        path=root/(name+".md"); source=path.read_text(encoding="utf-8")
        body,headings=render_markdown(source,advanced)
        toc="".join(f'<a class="h{level}" href="#{anchor}">{html.escape(title)}</a>' for level,title,anchor in headings if level in [2,3])
        edition="进阶版" if advanced else "MVP"
        headline="让协作规模增长，<br>让重复工作减少。" if advanced else "让团队知道，<br>下一步一起做什么。"
        sha=hashlib.sha256(path.read_bytes()).hexdigest()
        output=f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="source-sha256" content="{sha}"><title>共域 · {edition}需求 v2.0</title><style>{CSS}</style></head>
<body><a class="skip" href="#document">跳到需求正文</a><aside>
<a class="brand" href="#top">共域<small>COMMON GROUND / PRODUCT</small></a>
<div class="edition"><a class="{'active' if not advanced else ''}" href="01_MVP需求文档.html">MVP</a><a class="{'active' if advanced else ''}" href="02_进阶版需求文档.html">进阶版</a><a href="03_群聊协作原型.html">交互原型 ↗</a></div>
<nav class="toc" aria-label="需求目录">{toc}</nav><div class="side-note">v2.0 · 2026.10.18<br>产品方向评审稿<br>Owner = 主服务器设备</div></aside>
<main id="top"><div class="toolbar"><span>项目 C / 群聊协作 Agent / {edition}</span><div><a href="{name}.md" download>Markdown 源文档</a><a href="03_群聊协作原型.html">打开交互原型</a><button id="print">打印 / PDF</button></div></div>
<header class="hero"><div class="eyebrow">PRODUCT REQUIREMENTS / VERSION 2.0</div><h1>{headline}</h1><p>群聊共享上下文 · 主 Agent 协调判断 · 人与 Agent 共同推进</p><div class="meta"><span>文档<strong>{edition}需求</strong></span><span>状态<strong>方向评审，待原型反馈</strong></span><span>Owner<strong>主设备，非人工审批角色</strong></span></div></header>
<div class="note">本版替代 v1.2。判断目标是减少重复劳动、推进团队分工；现有 demo 仍是旧实现，原型仅使用演示数据。所有指标为待验证目标。</div>
<article id="document">{body}</article><footer><span>共域 · 需求与原型共同评审</span><span>Markdown 为编辑源 · HTML 离线可读 · 2026-10-18</span></footer></main>
<script>document.getElementById('print').addEventListener('click',()=>window.print());</script></body></html>"""
        target=root/(name+".html"); target.write_text(output,encoding="utf-8")
        print(json.dumps({"file":str(target),"version":"2.0","headings":len(headings),"source_sha256":sha},ensure_ascii=False))
if __name__=="__main__": main()
