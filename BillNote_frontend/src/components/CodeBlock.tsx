import { lazy, Suspense } from 'react'
import { Copy } from 'lucide-react'
import { toast } from 'react-hot-toast'

const LazyCodeBlockHighlighter = lazy(() => import('./CodeBlockHighlighter'))

interface CodeBlockProps {
  language: string
  code: string
}

export default function CodeBlock({ language, code }: CodeBlockProps) {
  return (
    <div className="group bg-muted relative my-6 overflow-hidden rounded-lg border shadow-sm">
      <div className="bg-muted text-muted-foreground flex items-center justify-between px-4 py-1.5 text-sm font-medium">
        <div>{language.toUpperCase()}</div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code)
            toast.success('代码已复制')
          }}
          className="bg-background/80 hover:bg-background flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors"
        >
          <Copy className="h-3.5 w-3.5" />
          复制
        </button>
      </div>
      <Suspense
        fallback={
          <pre className="m-0 overflow-x-auto p-4 font-mono text-[0.9rem] leading-relaxed">
            <code>{code}</code>
          </pre>
        }
      >
        <LazyCodeBlockHighlighter language={language} code={code} />
      </Suspense>
    </div>
  )
}
