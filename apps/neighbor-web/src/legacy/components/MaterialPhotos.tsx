import type { ComponentProps } from 'react';
import { MaterialPhotosUpload as SharedMaterialPhotosUpload } from '@legacy/components/MaterialPhotos';
import { auth } from '../lib/auth';

export * from '@legacy/components/MaterialPhotos';

export function MaterialPhotosUpload(props: Omit<ComponentProps<typeof SharedMaterialPhotosUpload>, 'getToken'>) {
  return <SharedMaterialPhotosUpload {...props} getToken={auth.getToken} />;
}
