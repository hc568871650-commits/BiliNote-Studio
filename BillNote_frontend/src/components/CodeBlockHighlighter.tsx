import { useEffect, useState } from 'react'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { atomDark as codeStyle } from 'react-syntax-highlighter/dist/esm/styles/prism'

const loadedLanguages = new Set<string>()

const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  js: () => import('react-syntax-highlighter/dist/esm/languages/prism/javascript'),
  javascript: () => import('react-syntax-highlighter/dist/esm/languages/prism/javascript'),
  jsx: () => import('react-syntax-highlighter/dist/esm/languages/prism/jsx'),
  ts: () => import('react-syntax-highlighter/dist/esm/languages/prism/typescript'),
  typescript: () => import('react-syntax-highlighter/dist/esm/languages/prism/typescript'),
  tsx: () => import('react-syntax-highlighter/dist/esm/languages/prism/tsx'),
  py: () => import('react-syntax-highlighter/dist/esm/languages/prism/python'),
  python: () => import('react-syntax-highlighter/dist/esm/languages/prism/python'),
  sh: () => import('react-syntax-highlighter/dist/esm/languages/prism/bash'),
  shell: () => import('react-syntax-highlighter/dist/esm/languages/prism/bash'),
  bash: () => import('react-syntax-highlighter/dist/esm/languages/prism/bash'),
  json: () => import('react-syntax-highlighter/dist/esm/languages/prism/json'),
  css: () => import('react-syntax-highlighter/dist/esm/languages/prism/css'),
  html: () => import('react-syntax-highlighter/dist/esm/languages/prism/markup'),
  xml: () => import('react-syntax-highlighter/dist/esm/languages/prism/markup'),
  markup: () => import('react-syntax-highlighter/dist/esm/languages/prism/markup'),
  sql: () => import('react-syntax-highlighter/dist/esm/languages/prism/sql'),
  rs: () => import('react-syntax-highlighter/dist/esm/languages/prism/rust'),
  rust: () => import('react-syntax-highlighter/dist/esm/languages/prism/rust'),
  go: () => import('react-syntax-highlighter/dist/esm/languages/prism/go'),
  java: () => import('react-syntax-highlighter/dist/esm/languages/prism/java'),
  c: () => import('react-syntax-highlighter/dist/esm/languages/prism/c'),
  cpp: () => import('react-syntax-highlighter/dist/esm/languages/prism/cpp'),
  yml: () => import('react-syntax-highlighter/dist/esm/languages/prism/yaml'),
  yaml: () => import('react-syntax-highlighter/dist/esm/languages/prism/yaml'),
  md: () => import('react-syntax-highlighter/dist/esm/languages/prism/markdown'),
  markdown: () => import('react-syntax-highlighter/dist/esm/languages/prism/markdown'),
  diff: () => import('react-syntax-highlighter/dist/esm/languages/prism/diff'),
}

interface CodeBlockHighlighterProps {
  language: string
  code: string
}

export default function CodeBlockHighlighter({ language, code }: CodeBlockHighlighterProps) {
  const normalized = language.toLowerCase()
  const [ready, setReady] = useState(() => loadedLanguages.has(normalized) || !LANGUAGE_LOADERS[normalized])

  useEffect(() => {
    const loader = LANGUAGE_LOADERS[normalized]
    if (!loader || loadedLanguages.has(normalized)) {
      setReady(true)
      return
    }
    let cancelled = false
    void loader()
      .then((mod) => {
        SyntaxHighlighter.registerLanguage(normalized, mod.default)
        loadedLanguages.add(normalized)
        if (!cancelled) setReady(true)
      })
      .catch(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [normalized])

  if (!ready || !LANGUAGE_LOADERS[normalized]) {
    return (
      <pre className="m-0 overflow-x-auto p-4 font-mono text-[0.9rem] leading-relaxed">
        <code>{code}</code>
      </pre>
    )
  }

  return (
    <SyntaxHighlighter
      style={codeStyle}
      language={normalized}
      PreTag="div"
      className="!bg-muted !m-0 !p-0"
      customStyle={{
        margin: 0,
        padding: '1rem',
        background: 'transparent',
        fontSize: '0.9rem',
      }}
    >
      {code}
    </SyntaxHighlighter>
  )
}
