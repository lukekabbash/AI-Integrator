import { useEffect, useState } from "react";

import { readBrowserBookmarks, type BrowserBookmark } from "./browserBookmarks";
import { withKnownFavicons } from "./browserFavicons";
import { subscribeBrowserPlaces } from "./browserPlaces";
import { readBrowserRecents, type BrowserRecent } from "./browserRecents";

// A place without an icon of its own borrows the one its host is known to
// wear, so a bookmark made from a local server or an early visit still shows
// the site's mark everywhere places are drawn.
const readRecents = () => withKnownFavicons(readBrowserRecents());
const readBookmarks = () => withKnownFavicons(readBrowserBookmarks());

export function useBrowserPlaces(): { recents: BrowserRecent[]; bookmarks: BrowserBookmark[] } {
  const [recents, setRecents] = useState(readRecents);
  const [bookmarks, setBookmarks] = useState(readBookmarks);

  useEffect(
    () =>
      subscribeBrowserPlaces(() => {
        setRecents(readRecents());
        setBookmarks(readBookmarks());
      }),
    [],
  );

  return { recents, bookmarks };
}
