'use client'

import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { motion } from 'framer-motion'
import { ArrowRight, CheckCircle2, Loader2, Zap } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { PageGlows } from '@/components/layout/PageGlows'
import { useCheckSlug, useCreateTenant } from '@/lib/api/queries/use-onboarding'
import { useDebounce } from '@/lib/hooks/use-debounce'

const schema = z.object({
  workspaceName: z.string().min(2, 'At least 2 characters').max(80, 'Max 80 characters'),
  slug: z
    .string()
    .min(3, 'At least 3 characters')
    .max(60, 'Max 60 characters')
    .regex(/^[a-z0-9-]+$/, 'Only lowercase letters, numbers, and hyphens'),
  yourName: z.string().min(2, 'Enter your name').max(100),
})

type FormData = z.infer<typeof schema>

function toSlug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
}

export default function OnboardingPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [slugEdited, setSlugEdited] = useState(false)
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null)

  const { register, handleSubmit, watch, setValue, formState } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { workspaceName: '', slug: '', yourName: '' },
  })

  const workspaceName = watch('workspaceName')
  const slug = watch('slug')
  const debouncedSlug = useDebounce(slug, 300)

  const checkSlug = useCheckSlug()
  const createTenant = useCreateTenant()

  // Auto-generate slug from workspace name
  useEffect(() => {
    if (!slugEdited && workspaceName) {
      setValue('slug', toSlug(workspaceName), { shouldValidate: true })
    }
  }, [workspaceName, slugEdited, setValue])

  // Check slug availability
  useEffect(() => {
    if (debouncedSlug.length >= 3) {
      checkSlug.mutate({ slug: debouncedSlug }, {
        onSuccess: (data) => setSlugAvailable(data.available),
        onError: () => setSlugAvailable(null),
      })
    } else {
      setSlugAvailable(null)
    }
  }, [debouncedSlug]) // eslint-disable-line

  const onSubmit = handleSubmit(async (data) => {
    if (!slugAvailable) {
      toast({ title: 'Slug unavailable', description: 'Choose a different workspace URL', variant: 'destructive' })
      return
    }
    try {
      await createTenant.mutateAsync(data)
      router.push('/dashboard')
    } catch {
      toast({ title: 'Failed to create workspace', variant: 'destructive' })
    }
  })

  const slugStatus = () => {
    if (debouncedSlug.length < 3) return null
    if (checkSlug.isPending) return <span className="text-white/40 text-xs">Checking...</span>
    if (slugAvailable === true) return <span className="text-brand-green text-xs flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Available</span>
    if (slugAvailable === false) return <span className="text-brand-coral text-xs">Already taken</span>
    return null
  }

  return (
    <div className="relative min-h-screen bg-brand-bg flex items-center justify-center overflow-hidden">
      <PageGlows />

      <div className="relative z-10 w-full max-w-md px-4">
        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <div className="inline-flex items-center gap-2 mb-4">
            <div className="w-10 h-10 bg-brand-blue rounded-xl flex items-center justify-center shadow-glow-blue">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <span className="text-2xl font-bold text-white">flicks<span className="text-brand-blue">.</span></span>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="glass rounded-xl p-8"
        >
          <h1 className="text-2xl font-bold text-white mb-2">Create your workspace</h1>
          <p className="text-brand-muted text-sm mb-8">This is where your team will live on Flicks Suite</p>

          <form onSubmit={onSubmit} className="space-y-5">
            {/* Workspace name */}
            <div className="space-y-2">
              <Label className="text-white/70 text-sm">Workspace name</Label>
              <Input
                placeholder="Acme Corp"
                className="bg-white/5 border-white/10 text-white placeholder:text-white/30 focus:border-brand-blue h-12"
                autoFocus
                {...register('workspaceName')}
              />
              {formState.errors.workspaceName && (
                <p className="text-brand-coral text-xs">{formState.errors.workspaceName.message}</p>
              )}
            </div>

            {/* Workspace URL */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-white/70 text-sm">Workspace URL</Label>
                {slugStatus()}
              </div>
              <div className="flex items-center gap-0 rounded-lg overflow-hidden border border-white/10 focus-within:border-brand-blue transition-colors">
                <span className="px-3 py-3 bg-white/5 text-white/40 text-sm border-r border-white/10 whitespace-nowrap">
                  app.flicks.app/
                </span>
                <Input
                  placeholder="acme-corp"
                  className="bg-transparent border-0 text-white placeholder:text-white/30 focus:ring-0 h-12 rounded-none flex-1"
                  onChange={(e) => {
                    setSlugEdited(true)
                    setValue('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''), { shouldValidate: true })
                  }}
                  value={slug}
                />
              </div>
              {formState.errors.slug && (
                <p className="text-brand-coral text-xs">{formState.errors.slug.message}</p>
              )}
            </div>

            {/* Your name */}
            <div className="space-y-2">
              <Label className="text-white/70 text-sm">Your name</Label>
              <Input
                placeholder="Niranjan Venugopal"
                className="bg-white/5 border-white/10 text-white placeholder:text-white/30 focus:border-brand-blue h-12"
                {...register('yourName')}
              />
              {formState.errors.yourName && (
                <p className="text-brand-coral text-xs">{formState.errors.yourName.message}</p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full h-12 bg-brand-blue hover:bg-brand-blue/90 text-white font-semibold shadow-glow-blue"
              disabled={createTenant.isPending || !slugAvailable}
            >
              {createTenant.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  Create workspace
                  <ArrowRight className="w-4 h-4 ml-2" />
                </>
              )}
            </Button>
          </form>
        </motion.div>
      </div>
    </div>
  )
}
