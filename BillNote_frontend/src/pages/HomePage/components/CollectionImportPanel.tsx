import { useMemo, useState } from 'react'
import { FolderPlus, Layers, Loader2, Sparkles, X } from 'lucide-react'
import type { CollectionItem, CollectionResolution } from '@/services/note'

interface CollectionImportPanelProps {
  resolution: CollectionResolution
  modelLabel: string
  submitting: boolean
  disabled?: boolean
  onDismiss: () => void
  onSubmitBatch: (options: {
    selectedItems: CollectionItem[]
    createFolder: boolean
    folderName: string
  }) => Promise<void>
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function CollectionImportPanel({
  resolution,
  modelLabel,
  submitting,
  disabled = false,
  onDismiss,
  onSubmitBatch,
}: CollectionImportPanelProps) {
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>(() =>
    resolution.items.filter(item => !item.already_exists).map(item => item.index),
  )
  const [createFolder, setCreateFolder] = useState(true)
  const [folderName, setFolderName] = useState(resolution.collection_title || '课程合集')

  const selectedSet = useMemo(() => new Set(selectedIndexes), [selectedIndexes])
  const selectedItems = useMemo(
    () => resolution.items.filter(item => selectedSet.has(item.index)),
    [resolution.items, selectedSet],
  )
  const existingCount = useMemo(
    () => resolution.items.filter(item => item.already_exists).length,
    [resolution.items],
  )

  const toggleIndex = (idx: number) => {
    setSelectedIndexes(prev => (prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]))
  }

  const selectNewOnly = () => {
    setSelectedIndexes(resolution.items.filter(item => !item.already_exists).map(item => item.index))
  }

  const selectAll = () => {
    setSelectedIndexes(resolution.items.map(item => item.index))
  }

  const clearAll = () => {
    setSelectedIndexes([])
  }

  const canSubmit = !disabled && !submitting && selectedItems.length > 0

  return (
    <section className="collection-import-panel" aria-label="多 P 合集批量导入">
      <div className="collection-import-head">
        <div className="collection-import-title-wrap">
          <span className="collection-import-badge">
            <Layers size={12} strokeWidth={1.8} aria-hidden="true" />
            <span>合集 · {resolution.total_count} 集</span>
          </span>
          <h3 className="collection-import-title" title={resolution.collection_title}>
            {resolution.collection_title}
          </h3>
        </div>
        <div className="collection-import-head-actions">
          {existingCount > 0 && (
            <button type="button" className="collection-link-btn" disabled={submitting} onClick={selectNewOnly}>
              只选未导入
            </button>
          )}
          <button
            type="button"
            className="collection-link-btn"
            disabled={submitting}
            onClick={selectedItems.length === resolution.items.length ? clearAll : selectAll}
          >
            {selectedItems.length === resolution.items.length ? '全不选' : '全选'}
          </button>
          <button
            type="button"
            className="collection-close-btn"
            aria-label="收起合集清单"
            title="收起合集清单"
            disabled={submitting}
            onClick={onDismiss}
          >
            <X size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="collection-import-list" role="list">
        {resolution.items.map(item => {
          const checked = selectedSet.has(item.index)
          const dur = formatDuration(item.duration)
          return (
            <label
              key={`${item.index}-${item.url}`}
              role="listitem"
              className={`collection-import-row ${checked ? 'is-selected' : ''} ${item.already_exists ? 'is-duplicate' : ''}`}
            >
              <input
                type="checkbox"
                className="collection-checkbox"
                checked={checked}
                disabled={submitting}
                onChange={() => toggleIndex(item.index)}
              />
              <span className="collection-checkbox-label">
                <span className="collection-item-index">P{item.index}</span>
                <span className="collection-item-title" title={item.title}>
                  {item.title}
                </span>
                {item.already_exists && <span className="collection-dup-pill">已有笔记</span>}
                {dur && <span className="collection-item-dur">{dur}</span>}
              </span>
            </label>
          )
        })}
      </div>

      <div className="collection-import-folder-row">
        <label className="collection-folder-toggle">
          <input
            type="checkbox"
            className="collection-checkbox"
            checked={createFolder}
            disabled={submitting}
            onChange={event => setCreateFolder(event.target.checked)}
          />
          <span className="collection-checkbox-label">
            <FolderPlus size={13} strokeWidth={1.7} aria-hidden="true" />
            <span>自动归入同名文件夹</span>
          </span>
        </label>
        {createFolder && (
          <input
            type="text"
            className="collection-folder-input"
            aria-label="合集文件夹名称"
            value={folderName}
            maxLength={60}
            disabled={submitting}
            placeholder="文件夹名称"
            onChange={event => setFolderName(event.target.value)}
          />
        )}
      </div>

      <div className="collection-import-foot">
        <p className="collection-cost-note">
          <Sparkles size={12} strokeWidth={1.7} aria-hidden="true" />
          <span>
            已选 <strong>{selectedItems.length}</strong> 集，将使用「{modelLabel}」依次发起 {selectedItems.length} 次模型调用（按模型实际用量计费）。
          </span>
        </p>
        <button
          type="button"
          className="composer-primary-btn collection-submit-btn"
          disabled={!canSubmit}
          onClick={() =>
            void onSubmitBatch({
              selectedItems,
              createFolder,
              folderName: folderName.trim() || resolution.collection_title || '课程合集',
            })
          }
        >
          {submitting ? <Loader2 size={14} className="generation-spin" aria-hidden="true" /> : <Layers size={14} aria-hidden="true" />}
          <span>{submitting ? '正在入队…' : `批量加入队列 (${selectedItems.length})`}</span>
        </button>
      </div>
    </section>
  )
}
