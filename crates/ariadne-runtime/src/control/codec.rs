use super::{error, io_error, CoreError, CoreErrorCode, MAX_FRAME_BYTES};
use serde::{de::DeserializeOwned, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub(crate) async fn read<T: DeserializeOwned>(
    stream: &mut (impl AsyncRead + Unpin),
) -> Result<T, CoreError> {
    let bytes = read_frame(stream).await?;
    serde_json::from_slice(&bytes).map_err(|_| {
        error(
            CoreErrorCode::InvalidArgument,
            "Control frame must be valid UTF-8 JSON with the exact typed envelope.",
        )
    })
}
pub(crate) async fn read_frame(
    stream: &mut (impl AsyncRead + Unpin),
) -> Result<Vec<u8>, CoreError> {
    let length = stream
        .read_u32()
        .await
        .map_err(|e| io_error("Read control frame length", e))? as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(error(
            CoreErrorCode::CapacityExceeded,
            "Control JSON frame must contain 1..=1MiB bytes.",
        ));
    }
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|e| io_error("Read complete control frame", e))?;
    Ok(bytes)
}
pub(crate) async fn write<T: Serialize>(
    stream: &mut (impl AsyncWrite + Unpin),
    value: &T,
) -> Result<(), CoreError> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        error(
            CoreErrorCode::InvalidArgument,
            "Cannot encode control envelope.",
        )
    })?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(error(
            CoreErrorCode::CapacityExceeded,
            "Control response exceeds 1MiB.",
        ));
    }
    stream
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|e| io_error("Write control frame length", e))?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|e| io_error("Write complete control frame", e))?;
    Ok(())
}
