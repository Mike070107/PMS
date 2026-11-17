import { MeterManagementWorkspace } from '@legacy/pages/MeterManagementPage';
import { pagePerm, useAuth } from '../lib/auth';
import { MaterialPhotosUpload } from '../components/MaterialPhotos';
import MeterPaymentMethods from '../components/MeterPaymentMethods';

export default function MeterManagementPage() {
  const session = useAuth();
  return <MeterManagementWorkspace session={session} permissions={pagePerm(session.access, 'meters')}
    PhotoUpload={MaterialPhotosUpload} PaymentMethods={MeterPaymentMethods} />;
}
