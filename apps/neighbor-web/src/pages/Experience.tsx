import { ExperienceNotebook } from '@legacy/pages/ExperienceNotesPage';
import RichNoteEditor from '@/components/RichNoteEditor';
import './Experience.css';

/** Existing entry; shared document/ACL behavior, neighbor brand and editor injection. */
export default function Experience() {
  return <ExperienceNotebook Editor={RichNoteEditor} className="experience-notebook--neighbor" />;
}
