import { FeeTemplateWorkspace } from '@legacy/pages/FeeTemplateSettings';
import { usePagePerm } from '../lib/auth';

export default function FeeTemplateSettings() {
  const { canEdit } = usePagePerm('settings');
  return <FeeTemplateWorkspace canEdit={canEdit} />;
}
