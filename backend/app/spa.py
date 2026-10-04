from __future__ import annotations

from pathlib import Path, PurePosixPath

from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


class SPAStaticFiles(StaticFiles):
    """Serve built assets and use index.html for extensionless browser routes."""

    def __init__(self, directory: Path) -> None:
        super().__init__(directory=str(directory), html=True, check_dir=True)

    async def get_response(self, path: str, scope: Scope):  # type: ignore[no-untyped-def]
        try:
            return await super().get_response(path, scope)
        except HTTPException as error:
            if error.status_code != 404 or not self._is_browser_route(path, scope):
                raise
            return await super().get_response("index.html", scope)

    @staticmethod
    def _is_browser_route(path: str, scope: Scope) -> bool:
        if scope.get("method") not in {"GET", "HEAD"}:
            return False
        if "text/html" not in Headers(scope=scope).get("accept", ""):
            return False
        if path.lstrip("/").startswith("api/"):
            return False
        # Missing files such as /assets/app.js must stay real 404s. React routes
        # in this application are extensionless (/ck/login, /ar/dashboard, etc.).
        return not PurePosixPath(path).suffix
