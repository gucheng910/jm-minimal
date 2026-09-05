import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerPwa } from "./pwa";

registerPwa();
createRoot(document.getElementById("root")!).render(<App />);