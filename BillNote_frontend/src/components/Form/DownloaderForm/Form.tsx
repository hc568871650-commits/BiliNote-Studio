// 下载器 Cookie 设置表单（最简化版）
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { getDownloaderCookie, updateDownloaderCookie } from '@/services/downloader' // 你自定义的请求
import { Link, useParams } from 'react-router-dom'
import { videoPlatforms } from '@/constant/note.ts'

const CookieSchema = z.object({
  cookie: z.string().min(10, '请填写有效 Cookie'),
})
const cookieDrafts = new Map<string, string>()

const DownloaderForm = () => {
  const form = useForm({
    resolver: zodResolver(CookieSchema),
    defaultValues: { cookie: '' },
  })
  const { id } = useParams()

  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadCookie = async () => {
      setLoading(true) // 🔁 切换平台时显示 loading
      try {
        const res = await getDownloaderCookie(id) as unknown as { cookie?: string }
        const cookie = cookieDrafts.get(id!) ?? res?.cookie ?? ''
        form.reset({ cookie }) // ✅ 正确重置表单值
      } catch (e) {
        toast.error('加载 Cookie 失败: ' + e)
        form.reset({ cookie: '' }) // ❗失败时也要清空旧值
      } finally {
        setLoading(false)
      }
    }

    if (id) loadCookie()
  }, [id, form]) // 🔁 每当 id 变化时触发
  useEffect(() => {
    const subscription = form.watch((values, info) => { if (id && info.type === 'change') cookieDrafts.set(id, values.cookie || '') })
    return () => subscription.unsubscribe()
  }, [id, form])

  const onSubmit = async (values: { cookie: string }) => {
    try {
      await updateDownloaderCookie({
        platform: id,
        cookie: String(values.cookie),
      })
      toast.success('保存成功')
      if (id) cookieDrafts.delete(id)
    } catch {
      toast.error('保存失败')
    }
  }

  if (loading) return <div className="settings-page">加载中…</div>

  return (
    <article className="settings-page">
      <nav className="settings-breadcrumb" aria-label="面包屑"><Link to="/settings/download">视频下载</Link><span aria-hidden="true">/</span><span>{videoPlatforms.find(item => item.value === id)?.label || '平台凭据'}</span></nav>
      <header className="settings-page-header"><h1>{videoPlatforms.find(item => item.value === id)?.label}下载凭据</h1><p>保存平台 Cookie，用于需要登录的视频下载。未保存修改仅保留在本次会话。</p></header>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <section className="settings-card">
          <FormField
            control={form.control}
            name="cookie"
            render={({ field }) => (
              <FormItem className="settings-field">
                <FormLabel>Cookie</FormLabel>
                <FormControl>
                  <Input {...field} type="password" autoComplete="off" placeholder="输入 Cookie" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          </section>
          <div className="settings-actions"><button className="settings-button is-primary" type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? '保存中…' : '保存凭据'}</button></div>
        </form>
      </Form>
    </article>
  )
}

export default DownloaderForm
