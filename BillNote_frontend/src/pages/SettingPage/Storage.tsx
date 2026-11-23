import { useCallback, useEffect, useRef, useState } from 'react'
import { ArchiveRestore, Download, Loader2, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { toast } from 'react-hot-toast'
import {
  clearTempMediaCache,
  getBackupDownloadUrl,
  getSystemStorage,
  restoreLibraryBackup,
  type StorageSummary,
} from '@/services/system'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let val = bytes
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx++
  }
  return `${val >= 100 || idx === 0 ? Math.round(val) : val.toFixed(1)} ${units[idx]}`
}

function formatShare(bytes: number, total: number): string {
  if (!total || bytes <= 0) return '0%'
  const pct = (bytes / total) * 100
  if (pct < 0.1) return '<0.1%'
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`
}

const CATEGORY_COLORS: Record<string, string> = {
  temp_media: 'var(--storage-cat-media)',
  note_results: 'var(--storage-cat-notes)',
  screenshots: 'var(--storage-cat-shots)',
  vector_db: 'var(--storage-cat-vector)',
  database: 'var(--storage-cat-db)',
}

function colorForCategory(id: string): string {
  return CATEGORY_COLORS[id] || 'var(--reading-accent, var(--primary))'
}

export default function StoragePage() {
  const [summary, setSummary] = useState<StorageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [pendingRestoreFile, setPendingRestoreFile] = useState<File | null>(null)
  const [lastPreBackup, setLastPreBackup] = useState('')
  const [hoveredCatId, setHoveredCatId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getSystemStorage()
      setSummary(data)
    } catch {
      toast.error('读取存储空间信息失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleClearCache = async () => {
    setClearing(true)
    try {
      const res = await clearTempMediaCache()
      setSummary(res.storage)
      setConfirmClear(false)
      toast.success(
        res.deleted_files > 0
          ? `已清理 ${res.deleted_files} 个临时缓存文件，释放 ${formatBytes(res.freed_bytes)}`
          : '当前没有可清理的临时音视频缓存',
      )
    } catch {
      toast.error('清理临时缓存失败，请重试')
    } finally {
      setClearing(false)
    }
  }

  const handleRestoreConfirm = async () => {
    if (!pendingRestoreFile || restoring) return
    setRestoring(true)
    try {
      const res = await restoreLibraryBackup(pendingRestoreFile)
      setLastPreBackup(res.pre_backup_path)
      setPendingRestoreFile(null)
      toast.success(`已恢复 ${res.restored_files} 个文件，建议刷新页面以加载最新笔记库`)
      await refresh()
    } catch (err) {
      const msg = (err as { msg?: string; message?: string })?.msg || (err as Error)?.message || '恢复备份失败'
      toast.error(msg)
    } finally {
      setRestoring(false)
    }
  }

  const tempCat = summary?.categories.find(c => c.id === 'temp_media')
  const totalBytes = summary?.total_bytes || 0
  const nonZeroCategories = (summary?.categories || []).filter(c => c.bytes > 0)
  const hoveredCat = hoveredCatId ? summary?.categories.find(c => c.id === hoveredCatId) || null : null

  return (
    <article className="settings-page">
      <header className="settings-page-header">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1>存储与维护</h1>
            <p>空间占比、临时缓存清理与整库备份</p>
          </div>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--surface-hairline)] px-3 text-xs hover:bg-[var(--surface-hover)]"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            <span>刷新统计</span>
          </button>
        </div>
      </header>

      <h2 className="settings-section-title">本地空间占用</h2>
      <section className="settings-card">
        {loading && !summary ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            <span>正在统计本地空间…</span>
          </div>
        ) : summary ? (
          <>
            <div className="flex flex-col gap-3 border-b border-[var(--surface-hairline)] px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <div>
                  <h2 className="text-[13px] font-medium text-foreground">合计占用</h2>
                  <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                    {hoveredCat
                      ? `${hoveredCat.label} · ${formatBytes(hoveredCat.bytes)}（${formatShare(hoveredCat.bytes, totalBytes)}）`
                      : '不含已下载的本地 Whisper 语音模型体积'}
                  </p>
                </div>
                <span className="text-sm font-semibold tabular-nums">{formatBytes(totalBytes)}</span>
              </div>

              {/* macOS 风格分类存储占比分布条（Flexbox 归一化占比 + 最小 5px 可见宽，绝不溢出裁切尾圆角） */}
              <div
                className="flex h-3 w-full gap-[1.5px] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--surface-text)_10%,transparent)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)]"
                role="img"
                aria-label={
                  totalBytes > 0
                    ? `存储占比分布：${nonZeroCategories.map(c => `${c.label} ${formatShare(c.bytes, totalBytes)}`).join('，')}`
                    : '暂无本地存储占用'
                }
                onMouseLeave={() => setHoveredCatId(null)}
              >
                {totalBytes > 0 && nonZeroCategories.map(cat => {
                  const dimmed = Boolean(hoveredCatId && hoveredCatId !== cat.id)
                  return (
                    <div
                      key={cat.id}
                      data-storage-bar-segment={cat.id}
                      title={`${cat.label}：${formatBytes(cat.bytes)}（${formatShare(cat.bytes, totalBytes)}）`}
                      onMouseEnter={() => setHoveredCatId(cat.id)}
                      style={{
                        flexGrow: cat.bytes,
                        flexShrink: 1,
                        flexBasis: 0,
                        minWidth: '5px',
                        backgroundColor: colorForCategory(cat.id),
                        opacity: dimmed ? 0.36 : 1,
                        transition: 'flex-grow 360ms var(--ease-spring), opacity 160ms var(--ease-apple)',
                      }}
                      className="h-full cursor-pointer first:rounded-l-full last:rounded-r-full"
                    />
                  )
                })}
              </div>

              {/* 紧凑色点图例 */}
              <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
                {summary.categories.map(cat => {
                  const dimmed = Boolean(hoveredCatId && hoveredCatId !== cat.id)
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-opacity hover:text-foreground"
                      style={{ opacity: dimmed ? 0.45 : 1 }}
                      onMouseEnter={() => setHoveredCatId(cat.id)}
                      onMouseLeave={() => setHoveredCatId(null)}
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: colorForCategory(cat.id) }}
                        aria-hidden="true"
                      />
                      <span>{cat.label}</span>
                      <span className="tabular-nums opacity-75">{formatShare(cat.bytes, totalBytes)}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {summary.categories.map(cat => {
              const active = hoveredCatId === cat.id
              return (
                <div
                  key={cat.id}
                  className="settings-row transition-colors"
                  style={active ? { backgroundColor: 'var(--surface-hover)' } : undefined}
                  onMouseEnter={() => setHoveredCatId(cat.id)}
                  onMouseLeave={() => setHoveredCatId(null)}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: colorForCategory(cat.id) }}
                      aria-hidden="true"
                    />
                    <div>
                      <h2>{cat.label}</h2>
                      <p>{cat.files} 个文件</p>
                    </div>
                  </div>
                  <span className="text-xs font-medium tabular-nums text-muted-foreground">
                    {formatBytes(cat.bytes)}
                    <span className="ml-1.5 opacity-70">{formatShare(cat.bytes, totalBytes)}</span>
                  </span>
                </div>
              )
            })}
            <div className="settings-row">
              <div>
                <h2>清理临时音视频缓存</h2>
                <p>仅删临时音视频缓存，保留笔记、截图与数据库</p>
              </div>
              {confirmClear ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={clearing}
                    className="rounded-full border border-[var(--surface-hairline)] px-3 py-1 text-xs"
                    onClick={() => setConfirmClear(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={clearing}
                    className="inline-flex items-center gap-1 rounded-full bg-destructive px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    onClick={() => void handleClearCache()}
                  >
                    {clearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    <span>确认清理</span>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={!tempCat || tempCat.bytes === 0}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--surface-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--surface-hover)] disabled:opacity-45"
                  onClick={() => setConfirmClear(true)}
                >
                  <Trash2 size={13} />
                  <span>一键清理</span>
                </button>
              )}
            </div>
          </>
        ) : null}
      </section>

      <h2 className="settings-section-title">整库备份与恢复</h2>
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <h2>导出整库 .zip 备份</h2>
            <p>含笔记、截图与数据库，默认不含 API Key 与 Cookie</p>
            <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={includeSecrets}
                onChange={e => setIncludeSecrets(e.target.checked)}
              />
              <span>包含 API 密钥与 Cookie 凭据（仅用于本人私密迁移）</span>
            </label>
          </div>
          <a
            href={getBackupDownloadUrl(includeSecrets)}
            download
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--reading-accent,var(--primary))] px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            <Download size={13} />
            <span>导出备份</span>
          </a>
        </div>

        <div className="settings-row">
          <div>
            <h2>从 .zip 备份恢复</h2>
            <p>导入前先校验并自动预备份当前数据至 backups 目录</p>
            {lastPreBackup && (
              <p className="mt-1 text-[11px] text-muted-foreground">最近预备份：{lastPreBackup}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={e => {
                const file = e.target.files?.[0] || null
                setPendingRestoreFile(file)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              disabled={restoring}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--surface-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--surface-hover)] disabled:opacity-45"
              onClick={() => fileInputRef.current?.click()}
            >
              <ArchiveRestore size={13} />
              <span>选择备份包</span>
            </button>
          </div>
        </div>

        {pendingRestoreFile && (
          <div className="mx-4 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2.5 text-xs">
            <span className="flex items-center gap-1.5 text-foreground">
              <ShieldAlert size={14} className="shrink-0 text-amber-500" />
              <span>即将恢复「{pendingRestoreFile.name}」，系统会先自动预备份当前数据。确认继续？</span>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={restoring}
                className="rounded-full border border-[var(--surface-hairline)] px-3 py-1 text-xs"
                onClick={() => setPendingRestoreFile(null)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={restoring}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--reading-accent,var(--primary))] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                onClick={() => void handleRestoreConfirm()}
              >
                {restoring && <Loader2 size={12} className="animate-spin" />}
                <span>{restoring ? '正在恢复…' : '确认恢复'}</span>
              </button>
            </div>
          </div>
        )}
      </section>
    </article>
  )
}
