import webbrowser
from memory import create_user,check_user,identify_user_id,remember_user,recall_user,remember_schedule,recall_schedules,remove_schedule,get_user_id
from openai import OpenAI
from datetime import datetime
import requests
import subprocess
import sys
import os
import speech_recognition as sr
print(sr.Microphone())

r = sr.Recognizer()
def speak(text):
    engine = pyttsx3.init()   #  fresh engine each time
    print("Bot:", text)
    voices = engine.getProperty('voices')
    engine.setProperty('voice', voices[1].id)  # try 0 or 1
    engine.setProperty('rate', 170)
    engine.say(text)
    engine.runAndWait()
    
   


def listen():
    r = sr.Recognizer()

    with sr.Microphone() as source:
        print("Listening...")
        audio = r.listen(source)
        print("processing......")

    try:
        text = r.recognize_google(audio)
        print("You said:", text)
        return text

    except sr.UnknownValueError:
        print("Sorry, I did not understand")
        return None

    except sr.RequestError:
        print("Network error")
        return None
   

# ==========================
# LM STUDIO / OPENAI SETUP
# ==========================
client = OpenAI(
    base_url="http://127.0.0.1:1234/v1",
    api_key="lm-studio"
)
# ==========================
# AI FUNCTION
# ==========================
messages = [
    {"role": "system", "content": "You are mimi, a helpful voice home assistant."}
]

def ask_nova(prompt):
    try:
        messages = [
            {
                "role": "system",
                "content": "You are Nova, a helpful and friendly AI Assistant that love to help around and learn new stuff."
            },
            {
                "role": "user",
                "content": prompt
            }
        ]

        response = client.chat.completions.create(
            model="gemma-2b-it",
            messages=messages,
            temperature=0.7
        )
        print("lm studio responding........")
        reply = response.choices[0].message.content
        print("Nova:",reply)
        return reply

    except Exception as e:
        print("LM Studio error:", e)
        return str(e)

import pyttsx3
def speak(text):
    engine = pyttsx3.init()   #  fresh engine each time
    print("Nova:", text)
    voices = engine.getProperty('voices')
    engine.setProperty('voice', voices[1].id)  # try 0 or 1
    engine.setProperty('rate', 200)
    engine.say(text)
    engine.runAndWait()


# ==========================
# STARTUP
# ==========================
speak("My name is Nova,  Your Friendly AI Assistant.")
speak("how may i help u?")
# ==========================
# MAIN LOOP
# ==========================
while True:
    text=listen()
    # COMMANDS SECOND
   

    if "search" in text:
        query = text.replace("search ", "").strip()
        webbrowser.open(f"https://google.com/search?q={query}")
        speak(f"Searching Google  {query}")

    
    elif "play" in text:
        song = text.replace("play", "").strip()
        webbrowser.open(f"https://youtube.com/results?search_query={song}")
        speak(f"Playing {song}")

    elif "whatsapp" in text:
        webbrowser.open("https://web.whatsapp.com")
        speak("Opening WhatsApp.")
    

    else:
            reply=ask_nova(text)
            speak(reply)
            
            
        

    




