FROM drakkarsoftware/octobot:stable

# Copy our pre-configured user directory into the image.
# This bakes the paper trading config into the image itself —
# it cannot be overridden by a volume mount on Railway.
COPY ./user_data /octobot/user

# OctoBot web UI listens on 5001 by default.
EXPOSE 5001
