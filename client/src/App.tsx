import { Navigate, Route, Routes } from "react-router-dom";
import { ProjectsPage } from "./pages/ProjectsPage";
import { RecordPage } from "./pages/RecordPage";
import { WalkthroughPage } from "./pages/WalkthroughPage";
import { TodayPage } from "./pages/TodayPage";
import "./offline/sync"; // bootstraps the background sync loop

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ProjectsPage />} />
      <Route path="/projects/:projectId/record" element={<RecordPage />} />
      <Route path="/walkthroughs/:id" element={<WalkthroughPage />} />
      <Route path="/today" element={<TodayPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
