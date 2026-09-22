// Public facade (Round N): modules bound by the facade-only dependency rule
// (CRM) import MediaService/MediaModule from here for signed-URL
// serialization. Everything else in this module stays private.
export { MediaService } from './media.service';
export { MediaModule } from './media.module';
