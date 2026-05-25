// Next.js client instrumentation — initialises browser-side Sentry.
import './sentry.client.config'

export { captureRouterTransitionStart as onRouterTransitionStart } from '@sentry/nextjs'
