import PdfList from './PdfList.jsx';
import { jobsApi } from '../../api/jobsClient.js';
import { JOB_STATUS_META, JOB_STATUS_ORDER } from '../Status.jsx';

// Vəzifə Təlimatları — same structure as Normativ Sənədlər:
//   Struktur vahidi (folder) -> Struktur bölməsi (folder) -> Vəzifə (ONE file each).
// Statuses: Mövcuddur / Mövcud deyil.
export default function JobList(props) {
  return (
    <PdfList
      {...props}
      apiClient={jobsApi}
      pageTitleKey="jobs_page_title"
      pageTitleDefault="Vəzifə Təlimatları"
      withStatus
      sheetsKind="jobs"
      statusMeta={JOB_STATUS_META}
      statusOrder={JOB_STATUS_ORDER}
      sheetsLabel="Vəzifə təlimatlarının hesabatı"
    />
  );
}
