import { useEffect, useRef, useState } from 'react'
import { Markmap } from 'markmap-view'
import { prefersReducedMotion } from '@/utils/motion'
import { transformer } from '@/lib/markmap.ts'
import { Toolbar } from 'markmap-toolbar'
import 'markmap-toolbar/dist/style.css'
import JSZip from 'jszip'
import type { INode } from 'markmap-common'
import { toast } from 'react-hot-toast'
import './reader.css'
import ChoiceSelect from '@/components/ChoiceSelect'

const MIN_EXPORT_FONT_PX = 256
const MIN_EXPORT_WIDTH = 12800
const WEB_EXPORT_SCALE_FACTOR = 0.34
const MAX_EXPORT_SCALE = 24
const MAX_CANVAS_SIDE = 32767
const MAX_CANVAS_PIXELS = 268000000

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob)
      } else {
        reject(new Error('无法创建PNG图片'))
      }
    }, 'image/png')
  })
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS('http://www.w3.org/2000/svg', tag)
}

function sanitizeSvgForCanvas(svg: SVGSVGElement): SVGSVGElement {
  const cloned = svg.cloneNode(true) as SVGSVGElement

  // markmap 会在 SVG 的顶层 <g> 上写入当前预览视口的 pan/zoom transform。
  // 导出时我们按内容 bbox 裁剪，如果保留这个视口 transform，会产生双重偏移，
  // 导致图片内容跑到角落并留下大片空白。这里只移除顶层视口 transform，
  // 保留内部节点自身的布局 transform。
  cloned.querySelector(':scope > g')?.removeAttribute('transform')

  cloned.querySelectorAll('image').forEach(el => el.remove())
  cloned.querySelectorAll('foreignObject').forEach((foreignObject) => {
    const textContent = foreignObject.textContent?.replace(/\s+/g, ' ').trim()
    if (!textContent) {
      foreignObject.remove()
      return
    }

    const x = Number(foreignObject.getAttribute('x') || 0)
    const y = Number(foreignObject.getAttribute('y') || 0)
    const height = Number(foreignObject.getAttribute('height') || 20)
    const text = createSvgElement('text')
    text.setAttribute('x', String(x))
    text.setAttribute('y', String(y + height / 2))
    text.setAttribute('dominant-baseline', 'middle')
    text.setAttribute('font-size', '14')
    text.setAttribute('font-family', 'Arial, "Microsoft YaHei", sans-serif')
    text.setAttribute('fill', '#333')
    text.textContent = textContent
    foreignObject.replaceWith(text)
  })

  return cloned
}

function getExportFontSize(svg: SVGSVGElement): number {
  const text = svg.querySelector('text, foreignObject')
  if (!text) return 14

  const fontSize = Number.parseFloat(getComputedStyle(text).fontSize || '')
  if (Number.isFinite(fontSize) && fontSize > 0) return fontSize

  const attrSize = Number.parseFloat(text.getAttribute('font-size') || '')
  return Number.isFinite(attrSize) && attrSize > 0 ? attrSize : 14
}

function getMindmapBounds(svg: SVGSVGElement) {
  const target = svg.querySelector('g') || svg
  const bbox = target.getBBox()
  const padding = 50
  return {
    x: Math.floor(bbox.x - padding),
    y: Math.floor(bbox.y - padding),
    width: Math.max(Math.ceil(bbox.width + padding * 2), 1),
    height: Math.max(Math.ceil(bbox.height + padding * 2), 1),
  }
}

function stripMindmapImages(markdown: string) {
  return (markdown || '')
    // 思维导图只保留文字结构，图片节点会让预览排版和 PNG 导出效果都很差。
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
}

function transformMindmap(markdown: string) {
  return transformer.transform(stripMindmapImages(markdown))
}

function createExportSvg(svgEl: SVGSVGElement) {
  const bounds = getMindmapBounds(svgEl)
  const clonedSvg = sanitizeSvgForCanvas(svgEl)

  clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clonedSvg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
  clonedSvg.setAttribute('width', String(bounds.width))
  clonedSvg.setAttribute('height', String(bounds.height))
  clonedSvg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`)
  clonedSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bgRect.setAttribute('x', String(bounds.x))
  bgRect.setAttribute('y', String(bounds.y))
  bgRect.setAttribute('width', String(bounds.width))
  bgRect.setAttribute('height', String(bounds.height))
  bgRect.setAttribute('fill', 'white')
  const firstG = clonedSvg.querySelector('g')
  clonedSvg.insertBefore(bgRect, firstG || clonedSvg.firstChild)

  return { clonedSvg, ...bounds }
}

async function exportSvgToPngBlob(svgEl: SVGSVGElement): Promise<Blob> {
  const { clonedSvg, width, height } = createExportSvg(svgEl)
  const svgData = new XMLSerializer().serializeToString(clonedSvg)
  const svgUrl = URL.createObjectURL(new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' }))

  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = svgUrl
    await img.decode()

    // 按导图内容尺寸和字号动态反推 PNG 倍率，而不是按预览容器或固定倍率导出。
    const fontScale = MIN_EXPORT_FONT_PX / getExportFontSize(svgEl)
    const widthScale = MIN_EXPORT_WIDTH / width
    const rawScale = Math.max(window.devicePixelRatio || 1, fontScale, widthScale)
    const sideLimitScale = Math.min(MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height)
    const pixelLimitScale = Math.sqrt(MAX_CANVAS_PIXELS / (width * height))
    const baseScale = Math.min(rawScale, MAX_EXPORT_SCALE, sideLimitScale, pixelLimitScale)
    const scale = Math.max(1, baseScale * WEB_EXPORT_SCALE_FACTOR)

    let currentScale = scale
    let lastError: unknown
    while (currentScale >= 1) {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(width * currentScale)
        canvas.height = Math.ceil(height * currentScale)

        const ctx = canvas.getContext('2d')
        if (!ctx) {
          throw new Error('无法获取Canvas上下文')
        }

        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.setTransform(currentScale, 0, 0, currentScale, 0, 0)
        ctx.drawImage(img, 0, 0, width, height)
        ctx.setTransform(1, 0, 0, 1, 0, 0)

        return await canvasToBlob(canvas)
      } catch (error) {
        lastError = error
        currentScale = Math.floor(currentScale / 2)
      }
    }
    throw lastError || new Error('导出PNG失败')
  } finally {
    URL.revokeObjectURL(svgUrl)
  }
}

export interface MarkmapEditorProps {
  /** 要渲染的 Markdown 文本 */
  value: string
  /** 内容变化时的回调 */
  onChange: (value: string) => void
  /** Toolbar 上要展示的 item id 列表，默认使用 Toolbar.defaultItems */
  toolbarItems?: string[]
  /** 自定义按钮列表，会依次注册 */
  customButtons?: any[]
  /** 容器 SVG 的高度，默认为 600px */
  height?: string
  /** 文档标题，用于导出HTML时的文件名 */
  title?: string
}

export default function MarkmapEditor({
  value,
  toolbarItems,
  customButtons = [],
  height = '600px',
  title = 'mindmap',
}: MarkmapEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const mmRef = useRef<Markmap | undefined>(undefined)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const toggleDoubleZoom = useRef<(point: [number, number]) => void>(() => {})
  const resetDoubleZoom = useRef<() => void>(() => {})
  const [selectable, setSelectable] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: Element | null } | null>(null)
  const [chapters, setChapters] = useState<INode[]>([])

  const plainText = (html: string) => {
    const element = document.createElement('div')
    element.innerHTML = html
    return element.textContent || ''
  }
  const focusNode = async (node: INode) => {
    const mm = mmRef.current
    if (!mm) return
    // Reveal folded ancestors before centering the destination.
    const reveal = async (current: INode): Promise<boolean> => {
      if (current === node) return true
      for (const child of current.children || []) {
        if (await reveal(child)) {
          if (current.payload?.fold) await mm.toggleNode(current)
          return true
        }
      }
      return false
    }
    if (mm.state.data) await reveal(mm.state.data)
    await mm.centerNode(node)
    await mm.setHighlight(node)
  }
  const handleMapClick = (event: React.MouseEvent) => {
    setContextMenu(null)
    const anchor = (event.target as Element).closest('a')
    const href = anchor?.getAttribute('href')
    if (!href?.startsWith('#')) return
    event.preventDefault()
    event.stopPropagation()
    let id = href.slice(1)
    try { id = decodeURIComponent(id) } catch { /* Match malformed ids as text. */ }
    const normalize = (text: string) => text.replace(/[-：:\s*\[\]]/g, '').toLowerCase()
    const target = normalize(id)
    const label = normalize(anchor?.textContent || '')
    const node = chapters.find(chapter => {
      const text = normalize(plainText(chapter.content))
      return text === target || text === label
    }) || chapters.find(chapter => {
      const text = normalize(plainText(chapter.content))
      return target.length > 0 && (text.includes(target) || target.includes(text))
    })
    if (node) void focusNode(node)
    else toast.error('未找到对应章节，请通过上方思维导图目录选择')
  }
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key) }
  }, [contextMenu])

  // 用于跟踪是否处于全屏状态
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [pngAction, setPngAction] = useState<'idle' | 'exporting' | 'copying'>('idle')
  const [pngMessage, setPngMessage] = useState('')

  const showPngMessage = (message: string) => {
    setPngMessage(message)
    window.setTimeout(() => setPngMessage(''), 2500)
  }

  // 监听全屏状态变化
  useEffect(() => {
    const handler = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handler)
    return () => {
      document.removeEventListener('fullscreenchange', handler)
    }
  }, [])

  // 进入全屏
  const enterFullscreen = () => {
    const el = svgRef.current?.parentElement
    if (el && el.requestFullscreen) {
      el.requestFullscreen()
    }
  }

  // 退出全屏
  const exitFullscreen = () => {
    if (document.exitFullscreen) {
      document.exitFullscreen()
    }
  }
  
  // 导出HTML思维导图
  const exportHtml = () => {
    try {
      const { root } = transformMindmap(value)
      const data = JSON.stringify(root)
      
      // 创建HTML内容
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title || 'BiliNote Studio 思维导图'}</title>
  <style>
  body {
    margin: 0;
    padding: 0;
    font-family: sans-serif;
  }
  #mindmap {
    display: block;
    width: 100%;
    height: 100vh;
  }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
  <script src="https://cdn.jsdelivr.net/npm/markmap-view@0.18.10"></script>
</head>
<body>
  <svg id="mindmap"></svg>
  <script>
  (async () => {
    const { markmap } = window;
    const { Markmap } = markmap;
    const mm = Markmap.create(document.getElementById('mindmap'));
    mm.setData(${data});
    mm.fit();
  })();
  </script>
</body>
</html>`;
      
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title || 'mindmap'}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('导出HTML失败:', error);
    }
  };

  // 导出SVG思维导图（矢量图）
  const exportSvg = async () => {
    try {
      if (!svgRef.current || !mmRef.current) return;

      const svgEl = svgRef.current;
      const mm = mmRef.current;

      // 先调用fit()确保显示完整的思维导图内容
      await mm.fit();
      // 等待渲染完成
      await new Promise(resolve => setTimeout(resolve, 100));

      // 克隆SVG以避免修改原始SVG
      const clonedSvg = svgEl.cloneNode(true) as SVGSVGElement;

      // 获取SVG内容的实际边界框
      const gElement = svgEl.querySelector('g');
      if (gElement) {
        const bbox = gElement.getBBox();
        // 添加一些边距
        const padding = 50;
        const viewBoxX = bbox.x - padding;
        const viewBoxY = bbox.y - padding;
        const viewBoxWidth = bbox.width + padding * 2;
        const viewBoxHeight = bbox.height + padding * 2;

        // 设置viewBox以确保SVG可以无限缩放
        clonedSvg.setAttribute('viewBox', `${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}`);
        // 移除固定尺寸，让SVG根据viewBox自适应
        clonedSvg.removeAttribute('width');
        clonedSvg.removeAttribute('height');
        // 设置默认尺寸为100%，可以在任何容器中自适应
        clonedSvg.setAttribute('width', '100%');
        clonedSvg.setAttribute('height', '100%');
        // 保持宽高比
        clonedSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      }

      // 设置SVG的背景为白色
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = 'svg { background-color: white; }';
      clonedSvg.insertBefore(style, clonedSvg.firstChild);

      // 添加白色背景矩形（确保背景在所有查看器中都是白色）
      const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const viewBox = clonedSvg.getAttribute('viewBox')?.split(' ').map(Number) || [0, 0, 800, 600];
      bgRect.setAttribute('x', viewBox[0].toString());
      bgRect.setAttribute('y', viewBox[1].toString());
      bgRect.setAttribute('width', viewBox[2].toString());
      bgRect.setAttribute('height', viewBox[3].toString());
      bgRect.setAttribute('fill', 'white');
      // 插入到最前面作为背景
      const firstG = clonedSvg.querySelector('g');
      if (firstG) {
        clonedSvg.insertBefore(bgRect, firstG);
      } else {
        clonedSvg.insertBefore(bgRect, clonedSvg.firstChild);
      }

      // 确保SVG有正确的命名空间
      clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clonedSvg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

      // 序列化SVG
      const svgData = new XMLSerializer().serializeToString(clonedSvg);

      // 创建下载
      const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title || 'mindmap'}.svg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('导出SVG失败:', error);
    }
  };

  // 导出XMind格式思维导图
  const exportXMind = async () => {
    try {
      const { root } = transformMindmap(value);

      // 生成唯一ID
      const generateId = () => Math.random().toString(36).substring(2, 15);

      // 解码HTML实体（如 &#x5b9e; -> 实，&#12345; -> 对应字符）
      const decodeHtmlEntities = (text: string): string => {
        if (!text) return text;

        // 首先手动处理十六进制数字实体 &#xHHHH;
        let decoded = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
          return String.fromCodePoint(parseInt(hex, 16));
        });

        // 处理十进制数字实体 &#DDDD;
        decoded = decoded.replace(/&#(\d+);/g, (_, dec) => {
          return String.fromCodePoint(parseInt(dec, 10));
        });

        // 使用textarea处理命名实体（如 &amp; &lt; &gt; 等）
        const textarea = document.createElement('textarea');
        textarea.innerHTML = decoded;
        return textarea.value;
      };

      // 清理HTML标签，只保留纯文本
      const stripHtml = (html: string): string => {
        if (!html) return html;
        // 先解码HTML实体
        let text = decodeHtmlEntities(html);
        // 移除HTML标签
        const div = document.createElement('div');
        div.innerHTML = text;
        return div.textContent || div.innerText || text;
      };

      // 将 markmap 节点转换为 XMind 节点格式
      const convertToXMindNode = (node: any, isRoot = false): any => {
        const rawTitle = node.content || node.payload?.content || '未命名';
        const xmindNode: any = {
          id: generateId(),
          class: isRoot ? 'topic' : 'topic',
          title: stripHtml(rawTitle),
        };

        if (node.children && node.children.length > 0) {
          xmindNode.children = {
            attached: node.children.map((child: any) => convertToXMindNode(child, false))
          };
        }

        return xmindNode;
      };

      const rootTopic = convertToXMindNode(root, true);
      const sheetId = generateId();

      // XMind content.json 结构
      const content = [{
        id: sheetId,
        class: 'sheet',
        title: stripHtml(title) || '思维导图',
        rootTopic: rootTopic,
        topicPositioning: 'fixed'
      }];

      // XMind metadata.json
      const metadata = {
        creator: {
          name: 'BiliNote Studio',
          version: '1.0.0'
        }
      };

      // XMind manifest.json
      const manifest = {
        'file-entries': {
          'content.json': {},
          'metadata.json': {}
        }
      };

      // 使用 JSZip 创建 .xmind 文件
      // 直接传入字符串，JSZip会自动处理UTF-8编码
      const zip = new JSZip();
      zip.file('content.json', JSON.stringify(content, null, 2));
      zip.file('metadata.json', JSON.stringify(metadata, null, 2));
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));

      // 生成 ZIP 并下载
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title || 'mindmap'}.xmind`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('导出XMind失败:', error);
    }
  };

  // 导出PNG思维导图
  const exportPng = async () => {
    try {
      if (!svgRef.current || !mmRef.current) return;

      setPngAction('exporting');
      setPngMessage('正在生成高清 PNG…');
      const blob = await exportSvgToPngBlob(svgRef.current);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title || 'mindmap'}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showPngMessage('PNG 已开始下载');
    } catch (error) {
      console.error('导出PNG失败:', error);
      showPngMessage('导出 PNG 失败，请查看控制台');
    } finally {
      setPngAction('idle');
    }
  };

  // 复制PNG思维导图
  const copyPng = async () => {
    try {
      if (!svgRef.current || !mmRef.current) return;

      setPngAction('copying');
      setPngMessage('正在复制高清 PNG…');
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': exportSvgToPngBlob(svgRef.current),
        }),
      ]);
      showPngMessage('PNG 已复制');
    } catch (error) {
      console.error('复制PNG失败:', error);
      showPngMessage('复制 PNG 失败，请查看控制台');
    } finally {
      setPngAction('idle');
    }
  };

  // 初始化 Markmap 实例 + Toolbar
  useEffect(() => {
    if (!svgRef.current || mmRef.current) return
    const mm = Markmap.create(svgRef.current, { color: () => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(), maxWidth: 360 })
    mmRef.current = mm
    const normalDuration = mm.options.duration
    const applyMotionPreference = () => { mm.setOptions({ duration: prefersReducedMotion() ? 0 : normalDuration }) }
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    motionQuery.addEventListener('change', applyMotionPreference)
    applyMotionPreference()
    type Transform = Parameters<typeof mm.zoom.transform>[1]
    let currentTransform: Transform | null = null
    let savedTransform: Transform | null = null
    let pendingRestore: Transform | null = null
    mm.zoom.on('zoom.bilinote-toggle', event => { currentTransform = event.transform })
    resetDoubleZoom.current = () => { savedTransform = null; pendingRestore = null }
    toggleDoubleZoom.current = point => {
      if (!currentTransform) return
      // Cancel an unfinished fit/zoom before reversing; rapid double clicks must
      // still restore the original scale and position instead of accumulating.
      mm.svg.interrupt()
      if (pendingRestore) {
        mm.svg.call(mm.zoom.transform, pendingRestore)
        pendingRestore = null
      }
      const reduced = prefersReducedMotion()
      const target = mm.svg.transition().duration(reduced ? 0 : 180)
      if (savedTransform) {
        const restore = savedTransform
        savedTransform = null
        pendingRestore = restore
        target.call(mm.zoom.transform, restore).on('end.bilinote-toggle', () => {
          if (pendingRestore === restore) pendingRestore = null
        })
      } else {
        savedTransform = currentTransform
        target.call(mm.zoom.scaleBy, 2, point)
      }
    }
    // Markmap blocks mousedown on both text and fold circles by default. Let text
    // events bubble to its SVG zoom/pan handler; retain the circle's own handler.
    // New foreignObjects appear on expansion as well as on initial setData.
    const enableTextPan = () => { mm.svg.selectAll('foreignObject.markmap-foreign').on('mousedown', null) }
    const contentObserver = new MutationObserver(enableTextPan)
    contentObserver.observe(svgRef.current, { childList: true, subtree: true })

    if (toolbarRef.current) {
      toolbarRef.current.innerHTML = ''
      const toolbar = new Toolbar()
      toolbar.attach(mm)
      customButtons.forEach(btn => toolbar.register(btn))
      toolbar.setItems(toolbarItems ?? Toolbar.defaultItems)
      toolbarRef.current.appendChild(toolbar.render())
    }
    const observer = new MutationObserver(() => { applyMotionPreference(); void mm.renderData() })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-accent', 'data-reduced-motion'] })
    return () => { motionQuery.removeEventListener('change', applyMotionPreference); toggleDoubleZoom.current = () => {}; resetDoubleZoom.current = () => {}; mm.zoom.on('zoom.bilinote-toggle', null); contentObserver.disconnect(); observer.disconnect(); mm.destroy(); mmRef.current = undefined }
  }, [])

  // 当 value 变化时，重新渲染数据
  useEffect(() => {
    const mm = mmRef.current
    if (!mm) return
    const { root } = transformMindmap(value)
    let active = true
    resetDoubleZoom.current()
    setSelectable(false)
    mm.setData(root).then(async () => {
      if (!active) return
      const headings: INode[] = []
      const visit = (node: INode) => {
        if (/^h[1-6]$/.test(String(node.payload?.tag || ''))) headings.push(node)
        node.children?.forEach(visit)
      }
      if (mm.state.data) visit(mm.state.data)
      setChapters(headings)
      await mm.fit()
    })
    return () => { active = false }
  }, [value])

  // 文本输入变化回调（如果你自行添加 textarea 编辑区）
  // const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
  //   onChange(e.target.value)
  // }

  return (
    <div className={`mindmap-reader relative flex h-full min-h-0 flex-col bg-background ${selectable ? 'mindmap-selectable' : ''}`}>
      <div className="reader-tools mindmap-chapter-bar"><div className="reader-tools-content">
        <ChoiceSelect label="思维导图目录" value="" className="reader-chapter-choice" onChange={value => { if (value === '') return; const node = chapters[Number(value)]; if (node) void focusNode(node) }} options={[{ value:'', label:`目录 · ${chapters.length} 个章节` }, ...chapters.map((chapter, index) => ({ value:String(index), label:plainText(chapter.content) }))]} />
        <span className="mindmap-hint" title={selectable ? '文字选择已开启 · 右键可恢复拖动' : '拖动查看 · 双击放大/还原 · 滚轮缩放'}>{selectable ? '文字选择已开启 · 右键可恢复拖动' : '拖动查看 · 双击放大/还原 · 滚轮缩放'}</span>
      </div></div>
      {/* 全屏/退出全屏 按钮 */}
      <div className="absolute top-12 right-2 z-20 flex space-x-2">
        <button
          onClick={exportXMind}
          className="rounded p-1 hover:bg-accent"
          title="导出XMind格式"
        >
          🧠
        </button>
        <button
          onClick={exportSvg}
          className="rounded p-1 hover:bg-accent"
          title="导出SVG矢量图（可无限放大）"
        >
          📐
        </button>
        <button
          onClick={exportPng}
          className="rounded p-1 hover:bg-accent"
          title="导出PNG图片"
          disabled={pngAction !== 'idle'}
        >
          {pngAction === 'exporting' ? '⏳' : '🖼️'}
        </button>
        <button
          onClick={copyPng}
          className="rounded p-1 hover:bg-accent"
          title="复制PNG图片"
          disabled={pngAction !== 'idle'}
        >
          {pngAction === 'copying' ? '⏳' : '📋'}
        </button>
        <button
          onClick={exportHtml}
          className="rounded p-1 hover:bg-accent"
          title="导出HTML（可交互）"
        >
          💾
        </button>
        {isFullscreen ? (
          <button
            onClick={exitFullscreen}
            className="rounded p-1 hover:bg-accent"
            title="退出全屏"
          >
            🗗
          </button>
        ) : (
          <button onClick={enterFullscreen} className="rounded p-1 hover:bg-accent" title="全屏">
            🗖
          </button>
        )}
      </div>
      {pngMessage && (
        <div className="absolute top-11 right-2 z-20 rounded bg-card/95 px-2 py-1 text-xs text-muted-foreground shadow">
          {pngMessage}
        </div>
      )}

      {/* 如果需要编辑区，就自己加一个 <textarea> 并把 handleChange 绑上 */}
      {/* <textarea value={value} onChange={handleChange} className="mb-2 p-2 border rounded" /> */}

      {/* 思维导图区 */}
      <svg ref={svgRef} className="w-full min-h-0 flex-1" style={{ height, overflow: 'hidden' }} onClickCapture={handleMapClick} onDoubleClickCapture={event => {
        event.stopPropagation()
        const target = event.target as Element
        if (selectable && target.closest('foreignObject')) return
        event.preventDefault()
        if (event.button !== 0 || target.closest('circle, a')) return
        const rect = event.currentTarget.getBoundingClientRect()
        toggleDoubleZoom.current([event.clientX - rect.left, event.clientY - rect.top])
      }} onContextMenu={event => { event.preventDefault(); const rect = event.currentTarget.parentElement!.getBoundingClientRect(); setContextMenu({ x: Math.max(4, Math.min(event.clientX - rect.left, rect.width - 170)), y: Math.max(4, Math.min(event.clientY - rect.top, rect.height - 110)), target: (event.target as Element).closest('foreignObject') }); }} onMouseDownCapture={event => { if (selectable && event.button === 0 && (event.target as Element).closest('foreignObject')) event.stopPropagation() }} />
      {contextMenu && <div role="menu" aria-label="思维导图交互" className="mindmap-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={event => event.stopPropagation()}>
        <button role="menuitem" onClick={() => { setSelectable(!selectable); setContextMenu(null); window.getSelection()?.removeAllRanges() }}>{selectable ? '恢复拖动查看' : '启用文字选择'}</button>
        <button role="menuitem" disabled={!contextMenu.target} onClick={() => { const target = contextMenu.target; setSelectable(true); setContextMenu(null); requestAnimationFrame(() => { if (!target) return; const range = document.createRange(); range.selectNodeContents(target); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range) }) }}>选中当前节点文字</button>
      </div>}

      {/* 如果你还想保留 markmap-toolbar */}
      {/* <div ref={toolbarRef} className="absolute right-2 bottom-2 z-10" /> */}
    </div>
  )
}
