use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "command")]
pub enum Command {
    CREATE {
        id: String,
        url: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    SHOW {
        id: String,
    },
    HIDE {
        id: String,
    },
    REPOSITION {
        id: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    DESTROY {
        id: String,
    },
}
