//! Bound raw request lines before the SDK allocates or decodes JSON.
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, ReadBuf};

const MAX_LINE: usize = 1024 * 1024;
pub(crate) struct BoundedLines<R> {
    read: R,
    length: usize,
    failed: bool,
}
impl<R> BoundedLines<R> {
    pub(crate) fn new(read: R) -> Self {
        Self {
            read,
            length: 0,
            failed: false,
        }
    }
    fn fail(&mut self) -> Poll<io::Result<()>> {
        self.failed = true;
        Poll::Ready(Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid bounded MCP input line",
        )))
    }
}
impl<R: AsyncRead + Unpin> AsyncRead for BoundedLines<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.failed {
            return self.fail();
        }
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let mut bytes = [0; 8192];
        let capacity = output.remaining().min(bytes.len());
        let mut input = ReadBuf::new(&mut bytes[..capacity]);
        match Pin::new(&mut self.read).poll_read(context, &mut input) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(Err(error)) => {
                self.failed = true;
                return Poll::Ready(Err(error));
            }
            Poll::Ready(Ok(())) => {}
        }
        if input.filled().is_empty() && self.length != 0 {
            return self.fail();
        }
        for byte in input.filled() {
            if *byte == b'\n' {
                self.length = 0;
            } else if self.length == MAX_LINE {
                return self.fail();
            } else {
                self.length += 1;
            }
        }
        output.put_slice(input.filled());
        Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests;
