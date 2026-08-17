import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Test from "./Test";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="app">
      <Test />
    </main>
  </StrictMode>,
);
