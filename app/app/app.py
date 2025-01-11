import reflex as rx

from rxconfig import config
from reflex.components.component import NoSSRComponent


class State(rx.State):
    """The app state."""

    ...


class S2S(NoSSRComponent):
    library = "/public/s2s"
    tag = "S2S"

    wsEndpoint: rx.Var[str]
    startText: rx.Var[str]
    stopText: rx.Var[str]

    def add_imports(self):
        return {"react-use-websocket": ["useWebSocket"]}


def index() -> rx.Component:
    return rx.container(
        rx.vstack(
            rx.flex(
                rx.heading("S2S", size="8"),
                rx.color_mode.button(),
                width="100%",
                justify="between",
            ),
            rx.center(
                S2S.create(
                    wsEndpoint="ws://localhost:8765/realtime",
                    startText="Start",
                    stopText="Stop",
                ),
                width="100%",
            ),
            min_height="100vh",
            spacing="7",
        ),
    )


app = rx.App()
app.add_page(index)
