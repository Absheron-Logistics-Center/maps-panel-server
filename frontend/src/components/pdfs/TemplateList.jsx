import PdfList from './PdfList.jsx';
import { templatesApi } from '../../api/templatesClient.js';

// Şablonlar — same structure as the PDF (Normativ Sənədlər) section but backed
// by a separate data store (/api/templates). Has the same status control as
// Normativ Sənədlər.
export default function TemplateList(props) {
  return (
    <PdfList
      {...props}
      apiClient={templatesApi}
      pageTitleKey="tmpl_page_title"
      pageTitleDefault="Şablonlar"
      withStatus
      sheetsKind="templates"
    />
  );
}
