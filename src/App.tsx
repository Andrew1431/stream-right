import { Home } from "./Home";
import { RoomPage } from "./RoomPage";

export function App() {
  const room = location.pathname.match(/^\/r\/([^/]+)\/?$/);
  if (room) return <RoomPage roomId={decodeURIComponent(room[1])} />;
  return <Home />;
}
