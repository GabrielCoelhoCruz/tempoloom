import { render } from "preact";

function App() {
  return <main>Tempoloom</main>;
}

const root = document.getElementById("app");
if (root) render(<App />, root);
