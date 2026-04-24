import requests

CLIENT_ID = "4ZzjxrWTotnt0hwDzCfuMIkdaQ9o2nkpM2Wisay5"
CLIENT_SECRET = "y+AV+z6ZfnFon+/DbeCgALGsJcoKFjIJGmkcmkTlM"

url = "https://api.ordoro.com/oauth/token"

data = {
    "grant_type": "client_credentials"
}

response = requests.post(
    url,
    data=data,
    auth=(CLIENT_ID, CLIENT_SECRET)
)

print(response.status_code)
print(response.text)